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


def skill_path(name, scope="user", cwd=None):
    """Full path to a skill's SKILL.md (does not create anything)."""
    return skills_base(scope, cwd) / name / "SKILL.md"


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
