"""viewer.skills — one place that knows where a skill lives on disk.

A skill is a `SKILL.md` under `<base>/.claude/skills/<name>/`, where base is the
user home (scope="user", shared across every session on the host) or a project cwd
(scope="project"). Both the capabilities route (manual skill CRUD) and the org
skill-learning path (Harman/employee promotion) go through here — one source of
truth for the layout, no duplicated mkdir+write.
"""
import re
from pathlib import Path

SKILL_NAME_RE = re.compile(r"[\w-]+$")


def valid_name(name):
    return bool(SKILL_NAME_RE.match(name or ""))


def skills_base(scope="user", cwd=None):
    """The `.claude/skills` directory for a scope. project scope needs a cwd."""
    if scope == "project":
        if not cwd:
            raise ValueError("project scope needs a cwd")
        return Path(cwd) / ".claude" / "skills"
    return Path.home() / ".claude" / "skills"


def write_skill(name, content, scope="user", cwd=None):
    """Create/overwrite <base>/<name>/SKILL.md. Returns the written path.
    Raises ValueError on a bad name."""
    if not valid_name(name):
        raise ValueError("Skill name must be letters/digits/dashes/underscores")
    d = skills_base(scope, cwd) / name
    d.mkdir(parents=True, exist_ok=True)
    p = d / "SKILL.md"
    p.write_text(content or "")
    return p


def list_skill_names(scope="user", cwd=None):
    """Names of skills present under the scope (dirs containing a SKILL.md)."""
    base = skills_base(scope, cwd)
    if not base.is_dir():
        return []
    out = []
    for d in base.iterdir():
        if d.is_dir() and (d / "SKILL.md").exists():
            out.append(d.name)
    return sorted(out)


_FRONTMATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---", re.S)


def read_description(path):
    """The `description:` of a SKILL.md's frontmatter — the one-line trigger that
    tells a reader WHEN the skill applies. Handles the inline form and the YAML
    block forms (`>` / `|`: the value is the indented lines that follow), which
    hand-written skills commonly use. Empty if absent or unreadable."""
    try:
        m = _FRONTMATTER_RE.match(Path(path).read_text(errors="replace"))
    except OSError:
        return ""
    if not m:
        return ""
    lines = m.group(1).splitlines()
    for i, line in enumerate(lines):
        k, _, v = line.partition(":")
        if k.strip() != "description":
            continue
        v = v.strip()
        if v in (">", "|", ">-", "|-"):
            block = []
            for nxt in lines[i + 1:]:
                if nxt.strip() and not nxt.startswith((" ", "\t")):
                    break
                block.append(nxt.strip())
            return " ".join(x for x in block if x)
        return v.strip('"').strip("'")
    return ""


def library(ledger_rows, scope="user", cwd=None):
    """The skill library as a reader should see it: DISK is the truth for what
    exists (a SKILL.md the CLI will load as /<name>), the LEDGER adds provenance
    (who learned it, from which card/session). Derived, never stored:

      - on disk + in ledger  → the ledger row, with the file's description;
      - on disk only         → a row with origin None (hand-written / installed);
      - in ledger only       → status 'missing' (the file was deleted), so a stale
                               row is visible instead of silently vouching for a
                               skill nobody can invoke.
    """
    base = skills_base(scope, cwd)
    by_name = {}
    for r in ledger_rows:
        by_name.setdefault(r.get("name"), r)
    out = []
    for name in list_skill_names(scope, cwd):
        p = base / name / "SKILL.md"
        row = dict(by_name.pop(name, {}) or {})
        row.update({"name": name, "path": str(p),
                    "status": row.get("status") or "active",
                    "description": read_description(p)})
        out.append(row)
    for name, r in by_name.items():
        out.append({**r, "status": "missing", "description": ""})
    return out
