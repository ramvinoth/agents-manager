"""viewer.bootstrap — idempotent fresh-install for the empire.

`make bootstrap` (or `python3 -m viewer.bootstrap`) makes a clean checkout work:
creates the DB tables (+ seeds the board columns), seeds the CEO (Ram) and the
manager (Harman) as employees, ensures the shared skills dir exists, and writes a
default Harman config. Every step is a no-op if already done — safe to re-run.

Runs BEFORE the server is up (it is setup), so it imports db directly.
"""
import json
from pathlib import Path

from viewer import db

HARMAN_FILE = Path.home() / ".claude" / ".viewer-harman.json"
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


def _ensure_harman_config():
    if HARMAN_FILE.exists():
        return False
    HARMAN_FILE.parent.mkdir(parents=True, exist_ok=True)
    HARMAN_FILE.write_text(json.dumps(
        {"enabled": True, "interval": 30, "budget": 2, "projects": []}, indent=2))
    return True


def bootstrap():
    report = []
    # 1. Tables + seeded board columns (already idempotent).
    db.init_db()
    cols = [c["name"] for c in db.board_columns_list()]
    report.append(f"DB ready · columns: {', '.join(cols)}")
    # 2. CEO + Harman.
    created, present = _ensure_employees()
    if created:
        report.append(f"created employees: {', '.join(created)}")
    if present:
        report.append(f"employees present: {', '.join(present)}")
    # 3. Shared skills dir.
    SKILLS_DIR.mkdir(parents=True, exist_ok=True)
    report.append(f"skills dir: {SKILLS_DIR}")
    # 4. Harman config.
    report.append("harman config: created" if _ensure_harman_config() else "harman config: present")
    return report


if __name__ == "__main__":
    for line in bootstrap():
        print(" ·", line)
    print("bootstrap: done")
