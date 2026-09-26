"""Boot reconciliation acts on shared state — Postgres job_runs and the $TMPDIR
--settings files (provider credentials) — so it must run exactly when nothing
else can be running: a real boot, never a preflight boot on a spare port beside
the live server. Regression for job_runs 142/145 (live runs stamped 'server
restarted mid-run' by a sanity boot) and seven leaked viewer-run-*.json files.
"""
import os
import subprocess
import sys
import time


from viewer import engine

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Same stubbed boot as test_server_boot_log, but the reconciliation hooks record
# whether they were called instead of being neutralised.
BOOT = """
import threading, sys
from viewer import server, db
db.init_db = lambda: None
db.job_runs_abandon_running = lambda: print("RECONCILE job_runs") or 0
server.run_settings_paths_in_use = lambda: set()
server.run_settings_sweep_orphans = lambda live: print("RECONCILE settings") or []
server.loop_scheduler = lambda *a, **k: print("SCHEDULER started")
class _Blocking:
    def __init__(self, *a, **k): pass
    def serve_forever(self): threading.Event().wait()
server.PooledHTTPServer = _Blocking
server.main()
"""


def _boot(tmp_path, env):
    log = tmp_path / "viewer.log"
    with open(log, "w") as out:
        child = subprocess.Popen([sys.executable, "-c", BOOT], cwd=REPO, stdout=out, stderr=out,
                                 env={**os.environ, **env})
        try:
            deadline = time.time() + 15
            while time.time() < deadline and "Press Ctrl+C" not in log.read_text():
                assert child.poll() is None, log.read_text()
                time.sleep(0.1)
        finally:
            child.kill()
            child.wait()
    return log.read_text()


def test_real_boot_reconciles_and_starts_scheduler(tmp_path):
    out = _boot(tmp_path, {"VIEWER_PREFLIGHT": ""})
    assert "RECONCILE job_runs" in out
    assert "RECONCILE settings" in out
    assert "SCHEDULER started" in out
    assert "PREFLIGHT" not in out


def test_preflight_boot_touches_nothing_shared(tmp_path):
    out = _boot(tmp_path, {"VIEWER_PREFLIGHT": "1"})
    assert "RECONCILE" not in out
    assert "SCHEDULER" not in out
    assert "PREFLIGHT (VIEWER_PREFLIGHT)" in out
    assert "Local:     http://" in out   # it still serves, which is what preflight proves


def test_sweep_removes_only_orphans_with_our_prefix(tmp_path):
    live = tmp_path / "viewer-run-live.json"
    orphan = tmp_path / "viewer-run-dead.json"
    other = tmp_path / "viewer-prov-old.json"
    for p in (live, orphan, other):
        p.write_text('{"env":{"ANTHROPIC_AUTH_TOKEN":"secret"}}')
    removed = engine.run_settings_sweep_orphans([str(live)], tmpdir=tmp_path)
    assert removed == [str(orphan)]
    assert live.exists() and other.exists() and not orphan.exists()


def test_sweep_with_no_live_runs_clears_everything(tmp_path):
    files = [tmp_path / f"viewer-run-{i}.json" for i in range(3)]
    for p in files:
        p.write_text("{}")
    assert sorted(engine.run_settings_sweep_orphans([], tmpdir=tmp_path)) == sorted(str(p) for p in files)
    assert not any(p.exists() for p in files)


def test_paths_in_use_are_read_from_live_argv(monkeypatch):
    ps = ("/usr/bin/python3 server.py 8091\n"
          "claude -p --resume abc --settings /var/folders/x/T/viewer-run-a1.json --model m\n"
          "claude -p --settings /var/folders/x/T/viewer-run-b2.json\n"
          "grep viewer-run-\n")
    monkeypatch.setattr(engine.subprocess, "run",
                        lambda *a, **k: type("R", (), {"stdout": ps})())
    assert engine.run_settings_paths_in_use() == {
        "/var/folders/x/T/viewer-run-a1.json", "/var/folders/x/T/viewer-run-b2.json"}


def test_writer_and_sweeper_share_one_prefix():
    # The sweep only knows a file is ours by its prefix; the writer must use the same constant.
    import inspect
    src = inspect.getsource(engine.start_claude_run)
    assert "prefix=RUN_SETTINGS_PREFIX" in src
    assert '"viewer-run-"' not in src
