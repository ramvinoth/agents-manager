"""Every viewer module must import on Windows: none may import a POSIX-only
module at load time (pty, fcntl, termios, ...). The terminal device lives behind
orchestrator.ptyproc, which imports its platform modules only when it spawns.

Runs on every OS by hiding the POSIX-only modules in a fresh interpreter, so a
Mac or Linux run catches a new top-level `import fcntl` before Windows CI does.
"""
import os
import subprocess
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

_PROBE = r"""
import importlib, pkgutil, sys
POSIX_ONLY = {"pty", "fcntl", "termios", "tty", "resource", "pwd", "grp", "crypt", "readline", "curses"}

class HidePosixOnly:
    def find_spec(self, name, path=None, target=None):
        if name.split(".")[0] in POSIX_ONLY:
            raise ImportError("POSIX-only module: " + name)

for m in [m for m in sys.modules if m.split(".")[0] in POSIX_ONLY]:
    del sys.modules[m]
sys.meta_path.insert(0, HidePosixOnly())
import orchestrator
bad = []
for info in pkgutil.walk_packages(orchestrator.__path__, "orchestrator."):
    try:
        importlib.import_module(info.name)
    except Exception as e:
        bad.append(info.name + ": " + repr(e))
print("\n".join(bad))
sys.exit(1 if bad else 0)
"""


class ImportsWithoutPosixTest(unittest.TestCase):
    def test_every_viewer_module_imports_without_posix_only_modules(self):
        env = {**os.environ, "DATABASE_URL": "dbname=__unit_no_db host=/nonexistent"}
        r = subprocess.run([sys.executable, "-c", _PROBE], cwd=ROOT, env=env,
                           capture_output=True, text=True, timeout=180)
        self.assertEqual(r.returncode, 0, "modules that need a POSIX-only import:\n" + r.stdout + r.stderr[-2000:])


if __name__ == "__main__":
    unittest.main()
