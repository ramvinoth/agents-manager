"""The launchd log must show the boot banner and print() diagnostics while the
server is alive. Under launchd stdout is a regular file, so Python block-buffers
it; `launchctl kickstart -k` then SIGKILLs the process and the whole buffer is
lost. Regression for ~/Library/Logs/com.harman.viewer.log holding three boot
banners across weeks of restarts: main() must switch stdout to line buffering.

Run in a child process with stdout redirected to a file, exactly as launchd does,
and read the file while the child is still blocked in serve_forever.
"""
import os
import subprocess
import sys
import time

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# main() needs Postgres and a port; stub both so only the logging/banner path runs.
BOOT = """
import threading, sys
from viewer import server, db
db.init_db = lambda: None
db.job_runs_abandon_running = lambda: 0
server.run_settings_paths_in_use = lambda: set()
server.run_settings_sweep_orphans = lambda live: []
class _Blocking:
    def __init__(self, *a, **k): pass
    def serve_forever(self): threading.Event().wait()
server.PooledHTTPServer = _Blocking
server.loop_scheduler = lambda *a, **k: None
server.main()
"""


def test_banner_reaches_redirected_stdout_before_exit(tmp_path):
    log = tmp_path / "viewer.log"
    with open(log, "w") as out:
        child = subprocess.Popen([sys.executable, "-c", BOOT], cwd=REPO, stdout=out, stderr=out)
        try:
            deadline = time.time() + 15
            while time.time() < deadline:
                if "Local:     http://" in log.read_text():
                    break
                assert child.poll() is None, log.read_text()
                time.sleep(0.1)
            assert child.poll() is None, "boot did not block in serve_forever:\n" + log.read_text()
            assert "Local:     http://" in log.read_text(), log.read_text()
        finally:
            child.kill()
            child.wait()
