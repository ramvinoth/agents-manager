"""viewer.bootstrap — idempotent fresh-install for the empire.

`make bootstrap` (or `python3 -m viewer.bootstrap`) makes a clean checkout work:
creates the DB tables (+ seeds the board columns and Harman's default config) and
seeds the CEO (Ram) and the manager (Harman) as employees, and ensures the shared
skills dir exists. Every step is a no-op if already done — safe to re-run.

Runs BEFORE the server is up (it is setup), so it imports db directly.
"""
from pathlib import Path

from viewer import db

SKILLS_DIR = Path.home() / ".claude" / "skills"

_SEED_EMPLOYEES = [
    {"name": "Ram", "role": "Founder/CEO"},
    {"name": "Harman", "role": "Manager"},
]


def _ensure_employees():
    """Seed CEO + Harman if absent (dedupe by name). Returns (created, present)."""
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
    # 1. Tables (+ Harman's default config, seeded in init_db). Board columns are
    #    created per-project on demand (no global board).
    db.init_db()
    report.append("DB ready")
    # 2. CEO + Harman.
    created, present = _ensure_employees()
    if created:
        report.append(f"created employees: {', '.join(created)}")
    if present:
        report.append(f"employees present: {', '.join(present)}")
    # 3. Shared skills dir.
    SKILLS_DIR.mkdir(parents=True, exist_ok=True)
    report.append(f"skills dir: {SKILLS_DIR}")
    return report


if __name__ == "__main__":
    for line in bootstrap():
        print(" ·", line)
    print("bootstrap: done")
