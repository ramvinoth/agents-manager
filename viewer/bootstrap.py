"""viewer.bootstrap — idempotent fresh-install for the empire.

`make bootstrap` (or `python3 -m viewer.bootstrap`) makes a clean checkout work:
creates the DB tables (+ Harman's default config and the agent role templates,
seeded in init_db) and ensures the shared skills dir exists. Every step is a
no-op if already done — safe to re-run.

Runs BEFORE the server is up (it is setup), so it imports db directly.
"""
from pathlib import Path

from viewer import db

SKILLS_DIR = Path.home() / ".claude" / "skills"


def bootstrap():
    report = []
    # 1. Tables (+ Harman's default config, seeded in init_db). Board columns are
    #    created per-project on demand (no global board).
    db.init_db()
    report.append("DB ready")
    # 2. Shared skills dir.
    SKILLS_DIR.mkdir(parents=True, exist_ok=True)
    report.append(f"skills dir: {SKILLS_DIR}")
    return report


if __name__ == "__main__":
    for line in bootstrap():
        print(" ·", line)
    print("bootstrap: done")
