"""viewer.skills — one place that knows where a skill lives on disk.

A skill is a `SKILL.md` under `<base>/.claude/skills/<name>/`, where base is the
user home (scope="user", shared across every session on the host) or a project cwd
(scope="project"). Every path that writes a skill — manual CRUD from the
capabilities route, and skill promotion — goes through here: one source of truth
for the layout, no duplicated mkdir+write.

This module also installs the skills that SHIP WITH the product (see
`bundled_skills/` and `install_bundled()`), so every install gets them without
the user having to find and paste them.
"""
import hashlib
import json
import re
from pathlib import Path

SKILL_NAME_RE = re.compile(r"[\w-]+$")

# Skills that ship with agents-manager. Each is a directory under
# viewer/bundled_skills/ containing a SKILL.md, laid out exactly as an installed
# skill is — so installing one is a copy, not a transformation.
BUNDLED_DIR = Path(__file__).parent / "bundled_skills"

# Where install_bundled() records what it last wrote. See its docstring: this
# receipt is the whole reason an upgrade can refresh a bundled skill without
# ever overwriting an edit the user made to it.
RECEIPT_NAME = ".vcode-bundled.json"


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


# ── Bundled skills ───────────────────────────────────────────────────────────

def _digest(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def bundled_names():
    """Names of the skills that ship with agents-manager."""
    if not BUNDLED_DIR.is_dir():
        return []
    return sorted(d.name for d in BUNDLED_DIR.iterdir()
                  if d.is_dir() and (d / "SKILL.md").exists())


def install_bundled(scope="user", cwd=None):
    """Install every skill in bundled_skills/ into the skills dir for a scope.

    Called from bootstrap, so it runs on a fresh install AND on every upgrade.

    THE PROBLEM THIS SOLVES, AND WHY IT IS NOT A PLAIN COPY: an upgrade must be
    able to ship a better version of a bundled skill, and it must never clobber
    a user who edited theirs. Those two requirements conflict unless we can tell
    the two cases apart, and a file's mere presence cannot tell them apart.

    So each install writes a receipt (`.vcode-bundled.json`) next to the skill,
    recording the sha256 of exactly what it wrote. On the next run:

      * no SKILL.md            → install it.
      * SKILL.md, no receipt   → the user's own skill that happens to share the
                                 name. Never touched.
      * hash matches receipt   → untouched since we wrote it, so refreshing is
                                 safe. Rewritten only if the bundled copy
                                 actually changed.
      * hash differs           → the user edited it. Left exactly as it is.

    The receipt is what makes this converge rather than either freeze at v1 or
    silently destroy an edit. Returns a list of (name, action) for reporting.
    """
    base = skills_base(scope, cwd)
    results = []
    for name in bundled_names():
        source = (BUNDLED_DIR / name / "SKILL.md").read_text()
        want = _digest(source)
        d = base / name
        target, receipt = d / "SKILL.md", d / RECEIPT_NAME

        if target.exists():
            try:
                recorded = json.loads(receipt.read_text()).get("sha256")
            except (OSError, ValueError):
                recorded = None
            if recorded is None:
                results.append((name, "kept (not ours)"))
                continue
            have = _digest(target.read_text())
            if have != recorded:
                results.append((name, "kept (edited locally)"))
                continue
            if have == want:
                results.append((name, "current"))
                continue
            action = "updated"
        else:
            action = "installed"

        d.mkdir(parents=True, exist_ok=True)
        target.write_text(source)
        receipt.write_text(json.dumps({"sha256": want, "name": name}) + "\n")
        results.append((name, action))
    return results
