"""Chat control: in-flight runs, the message queue, interrupt, enqueue and steer."""
import threading
import time

from orchestrator import db, inference_health, procctl, resume
from orchestrator.config import CHAT_JOBS, CHAT_LOCK
from orchestrator.runtime.process import stream_user_message

RESUME_SETTLE = 5  # s: launchd's restart SIGTERMs the whole process group at once


def record_inflight(session_id, job, ref=None):
    """Durable "this turn is in flight" record, for every harness: a restart that
    kills the run leaves the row behind and boot resumes it (orchestrator/resume.py).
    `ref` is what the harness needs to resume beyond the session id."""
    try:
        db.inflight_run_start(session_id, job.get("host") or "local", job.get("cwd", ""),
                              job.get("mode", ""), job.get("model", ""), job["started"],
                              agent=job.get("agent") or "claude", ref=ref)
    except Exception as e:
        print(f"  ⚠ could not record in-flight turn {session_id[:8]} (a restart will not resume it): {e}")


def end_oneshot_inflight(session_id, job):
    """A one-shot run (Codex, Copilot, Pi, custom chat) ended: clear its in-flight
    row. A failed exit may be the child dying in a restart's group SIGTERM, so
    wait RESUME_SETTLE first — if the server goes down meanwhile the row
    survives for boot to resume. One-shots have no turn-open signal, so a failure
    the server outlives is the run's own and is not auto-resumed."""
    try:
        if job.get("returncode") != 0 and not job.get("interrupted"):
            time.sleep(RESUME_SETTLE)
        db.inflight_run_clear(session_id, job["started"])
    except Exception as e:
        print(f"  ⚠ could not clear in-flight turn {session_id[:8]}: {e}")


def _resume_cut_turn(session_id, job, leftovers):
    """Resume a run that died mid-turn, through the same path a restart uses.
    A server restart kills the whole process group, this thread included; if we
    are still here after RESUME_SETTLE the cut was not a restart, and boot's
    resume_inflight is not about to resume the same row."""
    time.sleep(RESUME_SETTLE)
    row = db.inflight_run_get(session_id, job["started"])
    if not row:
        return False  # a newer run of this session already replaced the row
    row["queue"] = leftovers
    if resume.capped(row):
        job["owner_told"] = True
    print(f"  ↻ turn {session_id[:8]} was cut off mid-way (rc={job.get('returncode')}); resuming it")
    return resume.resume_one(row, reason=job.get("stderr", ""))


def _watch_endpoint(job, proc, base_url, model, api_key=""):
    """Liveness watch for a run on a custom model endpoint: while the CLI waits
    on the model, probe the endpoint every POLL_INTERVAL; stop the turn only on
    the Watch's verdict (unreachable, or no longer working on our request), and
    record why so the finalizer surfaces it. A slow but progressing prefill is
    never cut off by a clock."""
    watch = inference_health.Watch(base_url)
    while True:
        time.sleep(inference_health.POLL_INTERVAL)
        if not job["running"] or job.get("proc") is not proc:
            return
        since = job["model_wait"].since
        if since is None:
            watch.reset()
            continue
        verdict = watch.observe(inference_health.probe(base_url, model, api_key),
                                time.time() - since)
        if verdict and job["running"] and job["model_wait"].since is not None:
            job["endpoint_issue"] = verdict
            procctl.terminate(proc)
            return


def feed_next_queued(session_id, job, proc):
    """At a turn's end, write the next queued message into the run's stdin.
    Returns True if one was sent. Never loses a message: once stdin is closed
    (the CLI can still emit more turns after that, e.g. on a background-task
    notification), the queue is left intact for the finalizer's follow-up run.
    A write that fails means the pipe is broken (the child is dying, so this
    run ends rc!=0, which the finalizer's rc==0 follow-up would skip): put the
    message back at the front and leave turn_open set, so the restored message
    rides the proven cut-off resume path (_resume_cut_turn carries leftovers
    regardless of rc) instead of being stranded."""
    with CHAT_LOCK:
        nxt = job["queue"].pop(0) if job["queue"] and job["stdin_open"] else None
        if nxt is None:
            job["stdin_open"] = False
            return False
        job["turn_open"] = True
        backlog = list(job["queue"])
    _persist_queue(session_id, backlog)
    try:
        stream_user_message(proc, nxt)
        return True
    except (OSError, ValueError):
        with CHAT_LOCK:
            job["queue"].insert(0, nxt)
            job["stdin_open"] = False
            backlog = list(job["queue"])
        _persist_queue(session_id, backlog)
        return False


def _persist_queue(session_id, backlog):
    """Mirror a run's message queue into its in-flight row, so messages queued
    behind a turn survive a restart with it. Best-effort."""
    try:
        db.inflight_run_queue(session_id, backlog)
    except Exception:
        pass


def interrupt_chat(session_id):
    """Abort the running turn (Esc in the TUI): an interrupt (SIGINT, or
    CTRL_BREAK on Windows), escalating to terminate and then a tree kill.
    Queued messages are dropped — an interrupt means 'stop what's planned'."""
    with CHAT_LOCK:
        job = CHAT_JOBS.get(session_id)
        if not job or not job["running"]:
            return False
        proc = job.get("proc")
        job["interrupted"] = True
        job["queue"] = []
        job["stdin_open"] = False
    if proc:
        procctl.interrupt(proc)

        def escalate(stop):
            try:
                if proc.poll() is None:
                    stop(proc)
            except OSError:
                pass
        threading.Timer(4.0, escalate, (procctl.terminate,)).start()
        threading.Timer(8.0, escalate, (procctl.kill,)).start()
    return True


def enqueue_chat(session_id, text):
    """Add a message to a running job's queue. Returns queue position or None."""
    with CHAT_LOCK:
        job = CHAT_JOBS.get(session_id)
        if not job or not job["running"]:
            return None
        job["queue"].append(text)
        backlog = list(job["queue"])
    _persist_queue(session_id, backlog)
    return len(backlog)


def steer_chat(session_id, text):
    """Inject a message into the running turn (CLI steering). Returns
    'steered', 'queued' (fell back — stdin already closing), or None."""
    with CHAT_LOCK:
        job = CHAT_JOBS.get(session_id)
        if not job or not job["running"]:
            return None
        proc = job.get("proc")
        if proc and job.get("stdin_open"):
            try:
                stream_user_message(proc, text)
                job["steered"] += 1
                return "steered"
            except (OSError, ValueError):
                job["stdin_open"] = False
        job["queue"].append(text)
        backlog = list(job["queue"])
    _persist_queue(session_id, backlog)
    return "queued"
