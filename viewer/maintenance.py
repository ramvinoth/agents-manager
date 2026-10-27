"""viewer.maintenance — the hourly maintenance window (Card 133).

Many agents change server code in parallel; each used to restart the server
whenever its own change was ready, cutting the others' turns off at random
times with no record. Now an agent files a restart REQUEST (who, commit, why)
and the window applies every queued request with ONE restart at :50 each hour:

1. nothing queued → nothing happens;
2. wait until no agent turn is running, for at most QUIET_CAP seconds (then go
   anyway: viewer.resume brings cut-off Claude turns back on boot);
3. preflight the code on disk on a spare port (VIEWER_PREFLIGHT=1). A failure
   keeps the old server running and tells the requesters why;
4. exit — the supervisor (launchd KeepAlive / systemd Restart=always) starts
   the new code. Without a supervisor nobody would bring it back, so it refuses;
5. the new process writes ONE audit entry (maintenance_restart): when, version
   and commit before → after, the requests, the preflight result and its own
   health — the record a SOC 2 reviewer asks for — and wakes each requester.

The owner's "restart now" is the same run without the clock or the quiet wait,
behind the Red gate (restart_now): an agent's request queues for the owner.

Hooked into engine.loop_scheduler (no permanent thread); a window in progress
runs on a short-lived thread so the scheduler keeps firing loops meanwhile.
"""
import datetime
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

from viewer import config, db

WINDOW_MINUTE = 50
QUIET_CAP = 600          # seconds to wait for running turns to finish
QUIET_POLL = 15
PREFLIGHT_TIMEOUT = 45   # seconds for the spare to answer GET /
_PENDING_KEY = "maintenance_pending"     # the restart in flight, across the exit
_LAST_KEY = "maintenance_last_window"    # hour already handled (survives the exit)

_running = threading.Lock()


def _git_head():
    try:
        out = subprocess.run(["git", "-C", str(config.STATIC_DIR), "rev-parse", "--short=12", "HEAD"],
                             capture_output=True, text=True, timeout=5)
        return out.stdout.strip() if out.returncode == 0 else ""
    except Exception:
        return ""


BOOT_COMMIT = _git_head()   # the code THIS process loaded, not whatever is on disk later
BOOT_TIME = time.time()     # imported at boot (server.py), so requests older than this are live


def window_key(now):
    """The hour a window belongs to, or None outside [:50, :00). Local time:
    the owner reads 'the 14:50 window' on their own clock."""
    t = datetime.datetime.fromtimestamp(now)
    return t.strftime("%Y-%m-%d %H") if t.minute >= WINDOW_MINUTE else None


def next_window(now):
    t = datetime.datetime.fromtimestamp(now).replace(second=0, microsecond=0)
    w = t.replace(minute=WINDOW_MINUTE)
    if w <= t:
        w += datetime.timedelta(hours=1)
    return w.timestamp()


def supervised():
    """True when a supervisor restarts this process after it exits."""
    return bool(os.environ.get("XPC_SERVICE_NAME", "").startswith("com.agents.")
                or os.environ.get("INVOCATION_ID"))


def busy():
    with config.CHAT_LOCK:
        return sum(1 for j in config.CHAT_JOBS.values() if j.get("running"))


def request(requested_by, session_id, commit, reason):
    """Queue one restart for the next window. Returns the row plus when it runs."""
    row = db.restart_request_add(requested_by, session_id, (commit or "")[:64], reason[:2000])
    return {**row, "next_window": next_window(time.time())}


def tick(now=None):
    """Called from loop_scheduler every ~5s. Opens at most one window per hour."""
    now = now or time.time()
    key = window_key(now)
    if not key or _running.locked() or db.setting_get(_LAST_KEY) == key:
        return False
    db.setting_set(_LAST_KEY, key)
    if not db.restart_requests_by_status("queued"):
        return False
    threading.Thread(target=run_window, kwargs={"trigger": f"window {key}:{WINDOW_MINUTE}"},
                     daemon=True, name="maintenance").start()
    return True


def restart_now(actor):
    """The owner's restart: no clock, no quiet wait; preflight still applies."""
    if _running.locked():
        return {"error": "a maintenance restart is already in progress"}
    db.restart_request_add(actor, "", "", "restart now")
    threading.Thread(target=run_window, kwargs={"trigger": f"restart now by {actor}", "quiet_cap": 0},
                     daemon=True, name="maintenance").start()
    return {"started": True}


def preflight():
    """Boot the code on disk on a spare loopback port. Returns (ok, log tail)."""
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    env = {**os.environ, "VIEWER_PREFLIGHT": "1", "VIEWER_HOST": "127.0.0.1"}
    with tempfile.TemporaryFile() as log:
        proc = subprocess.Popen([sys.executable, str(config.STATIC_DIR / "server.py"), str(port)],
                                cwd=str(config.STATIC_DIR), env=env, stdout=log,
                                stderr=subprocess.STDOUT, start_new_session=True)
        ok = False
        try:
            deadline = time.time() + PREFLIGHT_TIMEOUT
            while time.time() < deadline and proc.poll() is None:
                try:
                    with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=2) as r:
                        ok = r.status == 200
                        break
                except Exception:
                    time.sleep(1)
        finally:
            proc.kill()
            proc.wait(timeout=10)
        log.seek(0)
        tail = log.read().decode(errors="replace")[-1500:]
    return ok, ("spare answered GET / 200" if ok else (tail.strip() or "spare never answered"))


def run_window(trigger, quiet_cap=QUIET_CAP, check=None, leave=None, sleep=time.sleep):
    """One maintenance run. `check` (preflight) and `leave` (process exit) are
    injected in tests. Returns 'idle' | 'preflight_failed' | 'unsupervised' | 'restarting'."""
    check = check or preflight
    leave = leave or (lambda: os._exit(0))
    if not _running.acquire(blocking=False):
        return "idle"
    try:
        if not db.restart_requests_by_status("queued"):
            return "idle"
        waited = 0
        while busy() and waited < quiet_cap:
            sleep(QUIET_POLL)
            waited += QUIET_POLL
        reqs = db.restart_requests_by_status("queued")   # late requests ride along
        ids = [r["id"] for r in reqs]
        record = {"trigger": trigger, "started_at": time.time(), "waited_s": waited,
                  "turns_cut": busy(), "version_before": config.VERSION,
                  "commit_before": BOOT_COMMIT, "commit_on_disk": _git_head(),
                  "requests": [_summary(r) for r in reqs]}
        if not supervised():
            record["preflight"] = "not run"
            return _abort(ids, reqs, record, "unsupervised",
                          "nothing would start the server again after it exits "
                          "(no launchd/systemd supervisor), so it was not restarted")
        ok, detail = check()
        record["preflight"] = detail
        if not ok:
            return _abort(ids, reqs, record, "preflight_failed",
                          "the new code failed its preflight boot, so the old server keeps running")
        db.restart_requests_set_status(ids, "restarting")
        db.setting_set(_PENDING_KEY, record)
        leave()
        return "restarting"
    finally:
        _running.release()


def _summary(r):
    return {"id": r["id"], "by": r["requested_by"], "session": r["session_id"],
            "commit": r["commit_sha"], "reason": r["reason"][:300]}


def _abort(ids, reqs, record, outcome, why):
    db.restart_requests_set_status(ids, "failed")
    db.audit_append("maintenance", "maintenance_restart", record, outcome)
    _tell(reqs, f"Your restart request was NOT applied: {why}.\nPreflight: {record['preflight']}\n"
                "Fix the cause and file a new restart_request.")
    return outcome


def finish_after_boot(sleep=time.sleep, health=None):
    """On a real (non-preflight) boot: close the restart the previous process
    started. Writes the one audit entry and wakes the requesters."""
    record = db.setting_get(_PENDING_KEY)
    if record:
        db.setting_set(_PENDING_KEY, None)
    else:
        # Restarted outside the window (the owner's kickstart, a crash, a reboot):
        # requests filed before this boot are already live, so close them here
        # rather than let the next window cut every running turn for nothing.
        stale = [r for r in db.restart_requests_by_status("queued") if (r.get("created_at") or 0) < BOOT_TIME]
        if not stale:
            return None
        record = {"trigger": "restart outside the window", "version_before": "?", "commit_before": "",
                  "requests": [_summary(r) for r in stale]}
    sleep(5)   # let the HTTP server come up before probing it
    h = (health or _health)()
    record.update({"finished_at": time.time(), "version_after": config.VERSION,
                   "commit_after": BOOT_COMMIT, "health": h})
    ids = [r["id"] for r in record.get("requests", [])]
    db.restart_requests_set_status(ids, "done")
    db.audit_append("maintenance", "maintenance_restart", record, "restarted" if h.get("ok") else "unhealthy")
    reqs = [{"session_id": r.get("session"), "requested_by": r.get("by")} for r in record.get("requests", [])]
    _tell(reqs, (f"The server restarted in the maintenance window ({record['trigger']}). "
                 f"Version {record['version_before']} ({record['commit_before'] or '?'}) → "
                 f"{config.VERSION} ({BOOT_COMMIT or '?'}); health: {json.dumps(h)}. "
                 "Your change is live — verify it and finish the work it was for."))
    return record


def _health():
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{config.PORT}/healthz", timeout=5) as r:
            body = json.loads(r.read())
        return {"ok": bool(body.get("ok")) and body.get("db_ok") is not False,
                "version": body.get("version"), "db_schema": body.get("db_schema")}
    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}


def _tell(reqs, body):
    """Wake each requesting session once (its inbox, so the result lands in that
    chat). A request with no session — the owner's restart now — is a push: an
    inbox row needs a session mailbox to show on the phone."""
    from viewer import inbox
    seen = set()
    for r in reqs:
        sid = r.get("session_id") or ""
        if sid in seen:
            continue
        seen.add(sid)
        if sid:
            inbox.deliver_message("system", "maintenance", "session", sid, body)
        else:
            inbox._push_owner("Manager · maintenance", body, {})
