"""viewer.marketplace — browse and install MCP tools and skills from vetted
public sources, so the owner never hand-writes a config.

Sources (both public, no key):
  - MCP: the official MCP Registry (registry.modelcontextprotocol.io, v0 API).
    Publishers prove their namespace (io.github.<user>/… via GitHub, a domain
    via DNS) — it is the registry the MCP project itself runs.
  - Skills: github.com/anthropics/skills, Anthropic's published skill set.

Pure: every function takes `fetch(url) -> bytes` so tests run offline. The
install routes re-read the entry from the source by name and build the config
HERE — a client never supplies the command line it wants run. MCP installs
then go through Host.mcp_save, skills through viewer.skills, the same writers
the manual editors use; there is no second write path.
"""
import json
import posixpath
import time
from urllib.parse import quote, urlencode

REGISTRY = "https://registry.modelcontextprotocol.io/v0/servers"
SKILLS_REPO = "anthropics/skills"
SKILLS_TREE = f"https://api.github.com/repos/{SKILLS_REPO}/git/trees/main?recursive=1"
SKILLS_RAW = f"https://raw.githubusercontent.com/{SKILLS_REPO}/main/"
SKILL_MAX_BYTES = 2 * 1024 * 1024   # a skill is prose + a few scripts, not a dataset
CACHE_TTL = 3600


class MarketError(Exception):
    """A user-facing refusal; .status is the HTTP status to answer with."""

    def __init__(self, msg, status=400):
        super().__init__(msg)
        self.status = status


def _json(fetch, url):
    try:
        return json.loads(fetch(url))
    except MarketError:
        raise
    except Exception as e:
        raise MarketError(f"Marketplace unreachable: {e}", 502)


# --- MCP ------------------------------------------------------------------

# How each registry package type runs locally. oci (docker) and mcpb bundles
# need tooling Harman does not manage, so they are listed but not installable.
_RUNNERS = {"npm": ("npx", lambda p: ["-y", f"{p['identifier']}@{p['version']}"]),
            "pypi": ("uvx", lambda p: [f"{p['identifier']}=={p['version']}"])}
_REMOTE_TYPES = {"streamable-http": "http", "sse": "sse"}


def _install_plan(server):
    """The one way this entry can be installed, or None. A hosted remote wins
    (nothing to run on this machine); else the first npm/pypi stdio package."""
    for r in server.get("remotes") or []:
        if r.get("type") in _REMOTE_TYPES and r.get("url") and "{" not in r["url"]:
            return {"kind": "remote", "remote": r}
    for p in server.get("packages") or []:
        if p.get("registryType") in _RUNNERS and (p.get("transport") or {}).get("type") == "stdio":
            return {"kind": p["registryType"], "package": p}
    return None


def _inputs(plan):
    """What the owner must fill in: env vars for a package, headers for a remote."""
    if plan["kind"] == "remote":
        return [{"name": h["name"], "description": h.get("description", ""),
                 "secret": bool(h.get("isSecret")), "required": bool(h.get("isRequired")),
                 "default": h.get("value", "")} for h in plan["remote"].get("headers") or []]
    return [{"name": e["name"], "description": e.get("description", ""),
             "secret": bool(e.get("isSecret")), "required": bool(e.get("isRequired")),
             "default": e.get("default", "")} for e in plan["package"].get("environmentVariables") or []]


def mcp_entry(server):
    """A registry server → what the browse list shows."""
    plan = _install_plan(server)
    name = server["name"]
    return {"id": name,
            "title": server.get("title") or name.rsplit("/", 1)[-1],
            "description": server.get("description", ""),
            "version": server.get("version", ""),
            "publisher": name.split("/", 1)[0],
            "repo": (server.get("repository") or {}).get("url", ""),
            "install": plan["kind"] if plan else None,
            "inputs": _inputs(plan) if plan else []}


def mcp_search(fetch, q="", cursor=""):
    params = {"version": "latest", "limit": 30}
    if q:
        params["search"] = q
    if cursor:
        params["cursor"] = cursor
    d = _json(fetch, f"{REGISTRY}?{urlencode(params)}")
    return {"items": [mcp_entry(s["server"]) for s in d.get("servers") or [] if s.get("server")],
            "cursor": (d.get("metadata") or {}).get("nextCursor") or ""}


def mcp_lookup(fetch, name):
    return _json(fetch, f"{REGISTRY}/{quote(name, safe='')}/versions/latest")["server"]


def config_name(server):
    """The key it is saved under in .mcp.json: the registry name's last part."""
    return "".join(c if c.isalnum() or c in "-_" else "-" for c in server["name"].rsplit("/", 1)[-1]).strip("-") or "server"


def mcp_config(server, values):
    """The Claude Code mcpServers entry for `server`, with the owner's `values`
    for its inputs. Raises MarketError if it cannot be installed or a required
    input is empty."""
    plan = _install_plan(server)
    if not plan:
        raise MarketError("This server needs Docker or a bundle installer; Harman installs npm, PyPI and hosted servers only.")
    filled = {}
    for i in _inputs(plan):
        v = str((values or {}).get(i["name"]) or "").strip()
        if not v and i["required"]:
            raise MarketError(f"{i['name']} is required.")
        if v:
            filled[i["name"]] = v
    if plan["kind"] == "remote":
        cfg = {"type": _REMOTE_TYPES[plan["remote"]["type"]], "url": plan["remote"]["url"]}
        if filled:
            cfg["headers"] = filled
        return cfg
    p = plan["package"]
    command, base = _RUNNERS[plan["kind"]]
    args = base(p) + [a["value"] for a in p.get("packageArguments") or []
                      if a.get("type") == "positional" and a.get("value")]
    cfg = {"type": "stdio", "command": command, "args": args}
    if filled:
        cfg["env"] = filled
    return cfg


# --- skills -----------------------------------------------------------------

_cache = {}


def _cached(key, build, now=None):
    now = now or time.time()
    hit = _cache.get(key)
    if hit and hit[0] > now:
        return hit[1]
    val = build()
    _cache[key] = (now + CACHE_TTL, val)
    return val


def _frontmatter(text):
    """name/description/license from a SKILL.md's inline frontmatter."""
    out = {}
    if text.startswith("---"):
        for line in text.split("\n---", 1)[0].splitlines()[1:]:
            k, _, v = line.partition(":")
            if k.strip() in ("name", "description", "license"):
                out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def _skill_files(tree):
    """{skill name: [(path in repo, size)]} for every skills/<name>/ with a SKILL.md."""
    by = {}
    for t in tree.get("tree") or []:
        parts = t.get("path", "").split("/")
        if t.get("type") == "blob" and len(parts) >= 3 and parts[0] == "skills":
            by.setdefault(parts[1], []).append((t["path"], t.get("size") or 0))
    return {n: f for n, f in by.items() if f"skills/{n}/SKILL.md" in {p for p, _ in f}}


def _tree(fetch):
    # Cached: the GitHub API allows 60 unauthenticated calls an hour.
    return _cached("tree", lambda: _skill_files(_json(fetch, SKILLS_TREE)))


def skills_catalog(fetch):
    def build():
        files = _tree(fetch)
        out = []
        for name in sorted(files):
            try:
                fm = _frontmatter(fetch(f"{SKILLS_RAW}skills/{name}/SKILL.md").decode("utf-8", "replace"))
            except Exception:
                fm = {}
            out.append({"id": name, "title": fm.get("name") or name, "description": fm.get("description", ""),
                        "license": fm.get("license", ""), "files": len(files[name]),
                        "repo": f"https://github.com/{SKILLS_REPO}/tree/main/skills/{name}"})
        return out
    return _cached("skills", build)


def skill_bundle(fetch, name):
    """{relative path: bytes} for one skill, refusing traversal and oversize."""
    files = _tree(fetch).get(name)
    if not files:
        raise MarketError(f"No skill named {name} in {SKILLS_REPO}.", 404)
    if sum(s for _, s in files) > SKILL_MAX_BYTES:
        raise MarketError(f"{name} is larger than {SKILL_MAX_BYTES // 1048576} MB; install it by hand.", 413)
    prefix = f"skills/{name}/"
    out = {}
    for path, _ in files:
        rel = posixpath.normpath(path[len(prefix):])
        if rel.startswith(("..", "/")):
            raise MarketError(f"Unsafe path in {name}: {path}", 502)
        out[rel] = fetch(SKILLS_RAW + quote(path))
    return out
