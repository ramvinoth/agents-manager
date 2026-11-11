"""Size guard: no source file may grow past LIMIT lines.

A file this long has more than one job, and the next edit lands in the wrong place.
The files already over the limit are listed in OVERSIZED with the size they had when
the guard went in. That number is a ceiling that only goes down: shrink a file and
lower its entry (or drop it once it is under LIMIT); grow it and this test fails.
Plan: note "Server architecture: rename the server package into bounded contexts (plan)".
"""
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LIMIT = 1200
SOURCES = ("orchestrator", "web/src", "mobile-app/src")
SUFFIXES = (".py", ".ts", ".tsx")

OVERSIZED = {
    "orchestrator/db.py": 3498,
    "orchestrator/engine.py": 2678,
    "orchestrator/browser.py": 1407,
    "orchestrator/remote.py": 1398,
    "orchestrator/routes/sessions.py": 1375,
    "mobile-app/src/screens/ThreadScreen.tsx": 1536,
    "mobile-app/src/lib/styles.ts": 1451,
}


def _sizes():
    files = subprocess.run(["git", "ls-files", "--", *SOURCES], cwd=ROOT,
                           capture_output=True, text=True, check=True).stdout.split()
    for rel in files:
        p = ROOT / rel
        if p.suffix in SUFFIXES and p.is_file() and not p.is_symlink():
            yield rel, sum(1 for _ in p.open(encoding="utf-8", errors="replace"))


def test_no_file_grows_past_its_ceiling():
    sizes = dict(_sizes())
    over = {rel: n for rel, n in sizes.items() if n > OVERSIZED.get(rel, LIMIT)}
    assert not over, (
        f"over {LIMIT} lines (or past its recorded ceiling): {over}. "
        "Split the file by responsibility instead of raising the number.")


def test_ceilings_are_current():
    """A stale entry hides growth: once a file shrinks, its ceiling must follow."""
    sizes = dict(_sizes())
    stale = {rel: (cap, sizes.get(rel)) for rel, cap in OVERSIZED.items()
             if sizes.get(rel) is None or sizes[rel] < cap}
    assert not stale, f"lower these ceilings to the current size, or drop them under {LIMIT}: {stale}"
