"""viewer.bootstrap — idempotent fresh-install.

`make bootstrap` (or `python3 -m viewer.bootstrap`) makes a clean checkout work:
creates the DB tables, seeds the owner as an employee and installs the skills
that ship with the product. Every step is a no-op if already done — safe to
re-run.

Runs BEFORE the server is up (it is setup), so it imports db directly.
"""
from viewer import db, skills

_SEED_EMPLOYEES = [
    {"name": "Ram", "role": "Founder/CEO"},
]


def _ensure_employees():
    """Seed the owner if absent (dedupe by name). Returns (created, present)."""
    existing = {e["name"] for e in db.employee_list()}
    created, present = [], []
    for spec in _SEED_EMPLOYEES:
        if spec["name"] in existing:
            present.append(spec["name"])
        else:
            db.employee_create(spec["name"], role=spec["role"])
            created.append(spec["name"])
    return created, present


def bootstrap():
    report = []
    # 1. Tables (+ the orchestrator's default config, seeded in init_db). Board
    #    columns are created per-project on demand (no global board).
    db.init_db()
    report.append("DB ready")
    # 2. Owner employee.
    created, present = _ensure_employees()
    if created:
        report.append(f"created employees: {', '.join(created)}")
    if present:
        report.append(f"employees present: {', '.join(present)}")
    # 3. Shared skills dir + the skills that ship with the product.
    #
    # This runs on upgrade as well as on install, which is the point: the
    # container converge script calls `python3 -m viewer.bootstrap` for every
    # bundle it installs, so a new or improved bundled skill reaches existing
    # environments without anyone copying a file by hand. install_bundled()
    # decides per skill whether writing is safe — see its docstring.
    base = skills.skills_base()
    base.mkdir(parents=True, exist_ok=True)
    report.append(f"skills dir: {base}")
    for name, action in skills.install_bundled():
        report.append(f"skill {name}: {action}")
    return report


if __name__ == "__main__":
    for line in bootstrap():
        print(" ·", line)
    print("bootstrap: done")
