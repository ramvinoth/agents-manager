"""Agent CLIs on a remote host: install, binary discovery, sign-in state,
and the skills/MCP capabilities configured there."""
import json
import re
from pathlib import Path
from orchestrator.agents import ENABLED_AGENTS, agent_public, install_command
from orchestrator.remote.transport import SSH, _auth_kwargs, remote_run_python, remote_run_shell


def remote_agents_status(hid):
    """Which registered agents are installed AND signed in on a remote host.
    installed = runnable binary present; loggedIn = the agent's credentials file
    exists (claude ~/.claude/.credentials.json, codex ~/.codex/auth.json; pi
    authenticates via models.json so it reports True)."""
    probe = [{"id": a["id"], "bin": a["bin"]} for a in ENABLED_AGENTS]
    script = (
        "import os, json, shutil\n"
        "A = json.loads(" + repr(json.dumps(probe)) + ")\n"
        "home = os.path.expanduser('~')\n"
        "dirs = [home + '/.local/bin', '/usr/local/bin', '/usr/bin', '/opt/homebrew/bin']\n"
        "def sz(p):\n"
        "    try: return os.path.getsize(p)\n"
        "    except OSError: return 0\n"
        "def copilot_li():\n"
        "    try:\n"
        "        lines = open(home + '/.copilot/config.json').read().splitlines()\n"
        "        t = '\\n'.join(l for l in lines if not l.strip().startswith('//'))\n"
        "        d = json.loads(t) if t.strip() else {}\n"
        "        return bool(d.get('loggedInUsers') or d.get('copilotTokens'))\n"
        "    except Exception:\n"
        "        return False\n"
        "LOGIN = {'claude': sz(home + '/.claude/.credentials.json') > 2,\n"
        "         'codex': sz(home + '/.codex/auth.json') > 2, 'pi': True, 'copilot': copilot_li()}\n"
        "res = {}\n"
        "for a in A:\n"
        "    inst = bool(shutil.which(a['bin'])) or any(os.path.exists(d + '/' + a['bin']) for d in dirs)\n"
        "    res[a['id']] = {'installed': inst, 'loggedIn': LOGIN.get(a['id'])}\n"
        "print(json.dumps(res))\n"
    )
    txt = remote_run_python(hid, script)
    try:
        status = json.loads(txt.strip().splitlines()[-1])
    except Exception:
        status = {}
    out = []
    for a in ENABLED_AGENTS:
        st = status.get(a["id"]) or {}
        pub = agent_public(a, st.get("installed", False))
        pub["loggedIn"] = st.get("loggedIn")
        out.append(pub)
    return out


def remote_install_agent(hid, agent):
    with SSH.lock_for(hid):
        home = SSH.get(hid)["home"]
    rc, out = remote_run_shell(hid, install_command(agent, home), timeout=400)
    installed = False
    try:
        installed = bool(json.loads(remote_run_python(
            hid, "import shutil, os, json; h=os.path.expanduser('~');"
                 " print(json.dumps(bool(shutil.which(%r)) or os.path.exists(h+'/.local/bin/'+%r)))"
                 % (agent["bin"], agent["bin"])).strip().splitlines()[-1]))
    except Exception:
        pass
    return {"ok": rc == 0, "returncode": rc, "output": out[-6000:], "installed": installed}


# Locate the claude binary on a remote host. `bash -lc` does NOT source
# .bashrc on most distros (non-interactive), so nvm/npm installs are invisible
# to `which claude` — probe the filesystem for the usual install locations.
REMOTE_FIND_CLAUDE_SCRIPT = r"""
import glob, os, re, shutil
cands = []
w = shutil.which('claude')
if w: cands.append(w)
for pat in ['~/.local/bin/claude', '~/.claude/local/claude', '~/bin/claude',
            '/usr/local/bin/claude', '/opt/homebrew/bin/claude']:
    p = os.path.expanduser(pat)
    if os.path.exists(p): cands.append(p)
def ver(p):
    m = re.search(r'/v(\d+)\.(\d+)\.(\d+)/', p)
    return tuple(int(x) for x in m.groups()) if m else (0, 0, 0)
for root in ['~/.nvm/versions/node', '~/.local/share/nvm']:
    nvm = glob.glob(os.path.expanduser(root + '/*/bin/claude'))
    if nvm: cands.append(max(nvm, key=ver))
print(cands[0] if cands else '')
"""


def remote_claude_bin(hid):
    """Resolved claude path on the host, cached on the pooled connection
    (so it re-probes after a reconnect)."""
    c = SSH.get(hid)
    if "claude_bin" not in c:
        c["claude_bin"] = remote_run_python(hid, REMOTE_FIND_CLAUDE_SCRIPT).strip() or "claude"
    return c["claude_bin"]


REMOTE_FIND_CODEX_SCRIPT = r"""
import glob, os, re, shutil
cands = []
w = shutil.which('codex')
if w: cands.append(w)
for pat in ['~/.local/bin/codex', '~/bin/codex', '/usr/local/bin/codex',
            '/opt/homebrew/bin/codex', '/usr/bin/codex']:
    p = os.path.expanduser(pat)
    if os.path.exists(p): cands.append(p)
def ver(p):
    m = re.search(r'/v(\d+)\.(\d+)\.(\d+)/', p)
    return tuple(int(x) for x in m.groups()) if m else (0, 0, 0)
for root in ['~/.nvm/versions/node', '~/.local/share/nvm']:
    nvm = glob.glob(os.path.expanduser(root + '/*/bin/codex'))
    if nvm: cands.append(max(nvm, key=ver))
print(cands[0] if cands else '')
"""


def remote_codex_bin(hid):
    """Resolved codex path on the host, cached on the pooled connection."""
    c = SSH.get(hid)
    if "codex_bin" not in c:
        c["codex_bin"] = remote_run_python(hid, REMOTE_FIND_CODEX_SCRIPT).strip() or "codex"
    return c["codex_bin"]


def remote_copilot_bin(hid):
    """Resolved copilot path on the host (the app installs to ~/.local/bin — which
    isn't always on the login-shell PATH, so we resolve an absolute path), cached."""
    c = SSH.get(hid)
    if "copilot_bin" not in c:
        out = remote_run_shell(hid, 'command -v copilot 2>/dev/null || echo "$HOME/.local/bin/copilot"')
        txt = (out[1] if isinstance(out, tuple) else out) or ""
        lines = [ln.strip() for ln in txt.strip().splitlines() if ln.strip()]
        c["copilot_bin"] = (lines[-1] if lines else "") or (c.get("home", "~") + "/.local/bin/copilot")
    return c["copilot_bin"]


def remote_copilot_logged_in(hid):
    """True if Copilot has a stored login on the remote (~/.copilot/config.json has
    loggedInUsers/copilotTokens). The file has // comments, so strip them first."""
    try:
        out = remote_run_shell(hid, "cat ~/.copilot/config.json 2>/dev/null")
        txt = (out[1] if isinstance(out, tuple) else out) or ""
        txt = re.sub(r"^\s*//.*$", "", txt, flags=re.M)
        d = json.loads(txt) if txt.strip() else {}
        return bool(d.get("loggedInUsers") or d.get("copilotTokens"))
    except Exception:
        return False


def remote_codex_logged_in(hid):
    """Is codex signed in on the remote host (~/.codex/auth.json exists & >2b)?"""
    try:
        out = remote_run_python(
            hid,
            "import os;p=os.path.expanduser('~/.codex/auth.json');"
            "print('1' if os.path.exists(p) and os.path.getsize(p)>2 else '0')",
        )
    except Exception:
        return False
    return out.strip().endswith("1")


# Skills + MCP servers configured ON the remote host (mirrors serve_capabilities
# so the RHS panel and MCP editor act on the host you're connected to, not local).
REMOTE_CAPS_SCRIPT = r"""
import json, os, glob
home = os.path.expanduser('~')
cwd = CWD
skills = []; seen = set()
def desc_of(md):
    try:
        with open(md, errors='replace') as f:
            txt = f.read(4000)
    except Exception:
        return ''
    if txt.startswith('---'):
        end = txt.find('\n---', 3)
        for line in (txt[3:end] if end > 0 else '').splitlines():
            if line.strip().lower().startswith('description:'):
                return line.split(':', 1)[1].strip().strip('"').strip("'")
    return ''
def add_skill(md, source, editable):
    name = os.path.basename(os.path.dirname(md))
    key = source + ':' + name
    if key in seen: return
    seen.add(key)
    skills.append({'name': name, 'description': desc_of(md), 'source': source,
                   'path': md, 'editable': editable})
if cwd:
    for f in sorted(glob.glob(os.path.join(cwd, '.claude', 'skills', '*', 'SKILL.md'))):
        add_skill(f, 'project', True)
for f in sorted(glob.glob(os.path.join(home, '.claude', 'skills', '*', 'SKILL.md'))):
    add_skill(f, 'user', True)
proot = os.path.join(home, '.claude', 'plugins', 'cache')
for f in sorted(glob.glob(os.path.join(proot, '*', '*', '*', 'skills', '*', 'SKILL.md'))):
    parts = f.split(os.sep)
    add_skill(f, 'plugin:' + parts[-5], False)
mcp = []
def add_mcp(name, cfg, scope, editable):
    if not isinstance(cfg, dict): return
    transport = cfg.get('type') or ('http' if cfg.get('url') else 'stdio')
    target = cfg.get('url') or ' '.join([cfg.get('command', '')] + list(cfg.get('args', [])))
    mcp.append({'name': name, 'scope': scope, 'transport': transport,
                'target': target.strip(), 'config': cfg, 'editable': editable})
try:
    cj = json.load(open(os.path.join(home, '.claude.json')))
except Exception:
    cj = {}
for name, cfg in (cj.get('mcpServers') or {}).items():
    add_mcp(name, cfg, 'global', True)
if cwd:
    proj = (cj.get('projects') or {}).get(cwd) or {}
    for name, cfg in (proj.get('mcpServers') or {}).items():
        add_mcp(name, cfg, 'project-global', False)
    try:
        pm = json.load(open(os.path.join(cwd, '.mcp.json')))
        for name, cfg in (pm.get('mcpServers') or {}).items():
            add_mcp(name, cfg, 'project', True)
    except Exception:
        pass
for pf in sorted(glob.glob(os.path.join(proot, '*', '*', '*', '.mcp.json'))):
    try:
        pd = json.load(open(pf))
    except Exception:
        continue
    for name, cfg in (pd.get('mcpServers') or {}).items():
        add_mcp(name, cfg, 'plugin:' + pf.split(os.sep)[-3], False)
print(json.dumps({'skills': skills, 'mcp': mcp}))
"""


# Add / edit / delete an MCP server in the remote host's config (global
# ~/.claude.json or project <cwd>/.mcp.json). Mirrors handle_mcp_save.
REMOTE_MCP_SAVE_SCRIPT = r"""
import json, os, shutil, sys
name = P['name']; scope = P['scope']; cfg = P.get('config')
cwd = P.get('cwd'); delete = P.get('delete')
home = os.path.expanduser('~')
if scope == 'global':
    path = os.path.join(home, '.claude.json')
    try:
        data = json.load(open(path))
    except Exception as e:
        print(json.dumps({'error': 'Cannot read ~/.claude.json: ' + str(e)})); sys.exit()
    shutil.copy2(path, path + '.bak-viewer')
elif scope == 'project':
    if not cwd:
        print(json.dumps({'error': 'Session not found for project scope'})); sys.exit()
    path = os.path.join(cwd, '.mcp.json')
    try:
        data = json.load(open(path)) if os.path.exists(path) else {}
    except Exception:
        data = {}
    if os.path.exists(path):
        shutil.copy2(path, path + '.bak-viewer')
else:
    print(json.dumps({'error': 'Scope must be global or project'})); sys.exit()
servers = data.setdefault('mcpServers', {})
if delete:
    if servers.pop(name, None) is None:
        print(json.dumps({'error': 'Server not found in that scope'})); sys.exit()
else:
    servers[name] = cfg
try:
    open(path, 'w').write(json.dumps(data, indent=2))
except Exception as e:
    print(json.dumps({'error': str(e)})); sys.exit()
print(json.dumps({'saved': True, 'file': path}))
"""


def remote_capabilities(hid, cwd):
    hdr = "CWD=" + json.dumps(cwd or "") + "\n"
    txt = remote_run_python(hid, hdr + REMOTE_CAPS_SCRIPT)
    try:
        return json.loads(txt.strip().splitlines()[-1])
    except Exception:
        return {"skills": [], "mcp": []}


def remote_mcp_save(hid, name, scope, cfg, cwd, delete=False):
    # Reconstruct params via json.loads of a Python string literal: JSON
    # booleans/null (false/true/null) are NOT valid Python literals, so a raw
    # json.dumps embedded as `P={...}` would raise NameError on the host.
    params = {"name": name, "scope": scope, "config": cfg,
              "cwd": cwd or "", "delete": bool(delete)}
    hdr = "import json\nP = json.loads(%r)\n" % json.dumps(params)
    txt = remote_run_python(hid, hdr + REMOTE_MCP_SAVE_SCRIPT)
    try:
        return json.loads(txt.strip().splitlines()[-1])
    except Exception:
        return {"error": "remote MCP op failed: " + txt.strip()[-300:]}


def remote_mcp_probe(hid, name, cfg, cwd):
    """Handshake with an MCP server ON the remote host; returns the same dict
    orchestrator.mcp_probe.probe() does.

    Unlike its neighbours, this does NOT hand-copy the logic into a script
    string. orchestrator/mcp_probe.py imports stdlib only, so the module's own
    source is shipped and exec'd: the probe cannot drift from the local one.

    The probe runs on the host, so a server's command, url and any credentials
    in its config are exercised where they belong; only the result travels back.
    """
    try:
        src = (Path(__file__).resolve().parent.parent / "mcp_probe.py").read_text()
    except Exception as e:
        return {"name": name, "transport": "", "state": "failed", "detail": "",
                "error": f"Cannot read probe module: {e}",
                "tools": [], "server": {}, "elapsed_ms": 0}
    # Same json.loads-of-a-repr trick as remote_mcp_save: JSON false/true/null
    # are not Python literals, so an embedded json.dumps would NameError.
    params = {"name": name, "config": cfg, "cwd": cwd or ""}
    hdr = "import json\nP = json.loads(%r)\n" % json.dumps(params)
    tail = "\nprint(json.dumps(probe(P['name'], P['config'], P['cwd'])))\n"
    txt = remote_run_python(hid, hdr + src + tail)
    try:
        return json.loads(txt.strip().splitlines()[-1])
    except Exception:
        return {"name": name, "transport": "", "state": "failed", "detail": "",
                "error": "remote probe failed: " + txt.strip()[-300:],
                "tools": [], "server": {}, "elapsed_ms": 0}


def test_host_config(cfg):
    """Try a connection; return (ok, message)."""
    import paramiko
    client = paramiko.SSHClient()
    client.load_system_host_keys()  # verify known hosts; auto-add first-seen
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        kw = {"hostname": cfg["host"], "port": int(cfg.get("port", 22)),
              "username": cfg["user"], "timeout": 12}
        kw.update(_auth_kwargs(cfg))
        client.connect(**kw)
        # Same filesystem probe used for real runs — `which` alone misses
        # nvm/npm installs (not on the non-interactive login PATH).
        stdin, out, _ = client.exec_command("python3 -", timeout=15)
        stdin.write(REMOTE_FIND_CLAUDE_SCRIPT)
        stdin.channel.shutdown_write()
        found = out.read().decode().strip()
        return True, (f"connected; claude at {found}" if found
                      else "claude not found on remote — chat will fail")
    except Exception as e:
        return False, str(e)
    finally:
        try:
            client.close()
        except Exception:
            pass
