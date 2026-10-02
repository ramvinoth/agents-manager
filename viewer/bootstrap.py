"""viewer.bootstrap — idempotent fresh-install and upgrade.

`make bootstrap` (or `python3 -m viewer.bootstrap`) makes a clean checkout work:
creates the DB tables and installs the skills that ship with the product. Every
step is a no-op if already done — safe to re-run.

Runs BEFORE the server is up (it is setup), so it imports db directly.
"""
from viewer import db, skills


def bootstrap():
    report = []
    # 1. Tables (already idempotent).
    db.init_db()
    report.append("DB ready")
    # 2. Shared skills dir + the skills that ship with the product.
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
