"""The loop scheduler: fires due loops, purges expired rows, runs one loop iteration."""
import os
import time
import traceback
from pathlib import Path

from orchestrator import db
from orchestrator.config import CHAT_JOBS, CHAT_LOCK, CLAUDE_DIR, transcript_path
from orchestrator.runtime.runners.claude import start_claude_run
from orchestrator.runtime.summaries import extract_cwd

CHAT_JOB_TTL = 1800  # keep a finished chat job ~30 min for the UI to read final status


# A persisted run credential with no live job is kept this long before the hourly
# sweep drops it — long enough for a remote child that outlived a restart to keep
# calling back for a working day, short enough that a dead session's token does
# not stay valid indefinitely.
SESSION_TOKEN_MAX_AGE = 86400


_PURGE_INTERVAL = 3600  # run job-run retention at most hourly (matches orchestrator_tick's self-throttle idiom)


CANVAS_TOMBSTONE_TTL = 7 * 86400  # a deleted canvas element is kept a week so a peer offline that long still converges


_last_purge = 0.0


def fire_due_loops(launch, now):
    """One pass of the loop-firing section of loop_scheduler, extracted so its
    invariants (busy-defer, one-shot fire-once, audit-row ordering) are unit
    testable without a live thread. All state changes go through the db and the
    `launch` callback (run_loop_iteration); returns nothing.

    Firing is gated by TWO facts, both read fresh each pass:
      1. the loop_control mode — which ORIGINS are licensed to run;
      2. the automation master switch — a runtime halt on the autonomous side.
         With it off, agent-origin (agent) loops do not fire; the owner's own
         (user) loops follow the mode alone, because they are a human's asking —
         the machine being unattended does not pause them. Off, then, means
         exactly "nothing starts without a person asking": no
         agent-scheduled work — the switch's documented contract.
    A failed read falls back to 'user' with the switch treated as off — the
    same fail-safe direction the settings seed to. An empty origin set ('none'
    mode, or an agent-only mode while the switch is off) skips the query
    entirely: nothing fires, and nothing is bumped — paused, not skipped.
    """
    from orchestrator.loops import AGENT_ORIGIN, allowed_origins
    from orchestrator.orchestrator import automation_enabled, loop_mode
    try:
        origins = allowed_origins(loop_mode())
        autonomous = automation_enabled()
    except Exception:
        origins, autonomous = allowed_origins("user"), False
    # The master switch halts the autonomous side of the licensed set. Loops
    # left out here keep their schedule untouched (below) — a resume fires each
    # once, on its own cadence, instead of replaying the whole pause window.
    if not autonomous:
        origins = origins - {AGENT_ORIGIN}
    if not origins:
        return

    # Fire due loops. Per-tick bumps (nextRun/runs/lastRun) are written to the
    # loop's row atomically; job_runs records each firing for the audit trail.
    due = []
    for lp in db.loops_due(now, origins):
        job = CHAT_JOBS.get(lp["session"])
        if job and job["running"]:
            db.loop_update(lp["id"], {"nextRun": now + 30})  # session busy; retry shortly
            continue
        # One-shot ("at") tasks die on this fire, but the row is NOT deleted here:
        # the job_runs audit row is opened in the launch loop below and its loop_id
        # foreign key points at this loops row — deleting first makes that insert
        # violate the FK (the best-effort except swallows it) and the audit row is
        # lost. The launch loop deletes the row right after the audit row exists;
        # the FK's ON DELETE SET NULL then detaches the audit record instead of
        # destroying it, so the full history survives. A one-shot that then fails
        # to start (session busy/missing) is recorded in job_runs and done — never
        # retried tick after tick.
        if lp.get("kind") == "once":
            due.append(lp)
            continue
        # Cron-based jobs compute their next run from the cron expression;
        # interval-based ones just add the interval.
        cron_expr = lp.get("cron")
        if cron_expr:
            from orchestrator.loops import cron_next_run
            nxt = cron_next_run(cron_expr, now)
            next_run = nxt if nxt else now + 86400
        else:
            next_run = now + (lp.get("interval") or 0)
        db.loop_update(lp["id"], {
            "nextRun": next_run, "runs": (lp.get("runs") or 0) + 1, "lastRun": now})
        due.append(lp)
    for lp in due:
        lid, session, prompt = lp["id"], lp["session"], lp["prompt"]
        # Open a history row now; the run thread closes it via on_done. A run
        # that never starts (session busy/missing) is finalized here as an
        # error so no row is left dangling "running" forever.
        try:
            run_id = db.job_run_start(lid, session, prompt)
        except Exception:
            run_id = None
        # One-shot: the audit row exists now (its loop_id still points at the
        # live loops row), so retire the schedule — the FK's ON DELETE SET NULL
        # detaches the audit record instead of destroying it.
        if lp.get("kind") == "once":
            db.loop_delete(lid)

        def _on_done(rc, detail="", lid=lid, run_id=run_id):
            try:
                db.job_run_finish(run_id, rc, detail)
                db.loop_update(lid, {"lastRc": rc})
            except Exception:
                pass

        try:
            started = launch(session, lp["path"], prompt,
                             lp.get("model", ""), lp.get("provider", ""), _on_done)
        except Exception as e:
            started = False
            if run_id is not None:
                try:
                    db.job_run_finish(run_id, -1, str(e)[:2000])
                except Exception:
                    pass
        if not started and run_id is not None:
            try:
                db.job_run_finish(run_id, -1, "did not start (session busy or missing)")
            except Exception:
                pass


def loop_scheduler(launch):
    """Background thread: fire due loops, reap finished chat jobs so CHAT_JOBS
    doesn't grow unbounded, and hourly purge old job-run history.

    This thread is the ONLY place work starts without a human asking for it, and it
    carries two INDEPENDENT gates that must not be conflated:

    - scheduled-loop firing is gated by the loop_control mode (user|agent|both|none)
      — which origins' loops may run (fire_due_loops). The master switch plays no part.
    - Manager's manager tick is gated ONLY by the automation master switch (read fresh
      each pass; unreadable → treated as OFF).

    The owner can thus pause Manager's autonomy while their own scheduled loops keep
    running, and vice-versa. Paused means paused, not queued: a loop whose origin is
    disallowed keeps its nextRun untouched, so on resume it fires at most ONCE rather
    than replaying every run that came due in the meantime. Reaping and the retention
    purge still run regardless — they free memory, expire session tokens and bound the
    audit table, and holding stale credentials open would be the opposite of safe.
    """
    # One failed pass must never end the thread: it is the only thing that fires
    # loops AND opens the maintenance window, so its death is silent and total
    # (2026-11-04: a Postgres restart made loops_due raise, the thread died, and
    # nothing fired for ~26h while the server looked healthy). Log and go on.
    while True:
        time.sleep(5)
        try:
            _scheduler_pass(launch, time.time())
        except Exception:
            traceback.print_exc()


def _scheduler_pass(launch, now):
    """One 5s tick of loop_scheduler (see its docstring)."""
    global _last_purge
    with CHAT_LOCK:
        # Reap from when the run FINISHED, not when it started — a long run
        # otherwise loses its final status seconds after completing.
        stale = [sid for sid, j in CHAT_JOBS.items()
                 if not j.get("running") and now - j.get("finished", j.get("started", now)) > CHAT_JOB_TTL]
        for sid in stale:
            CHAT_JOBS.pop(sid, None)
            # The run is truly over — drop its persisted tokens too, so a
            # stale credential can't authorize an MCP call after the session
            # ends (preserves the "only live sessions" guarantee).
            try:
                db.session_token_delete(sid)
            except Exception:
                pass
    # Retention: bound job-run history so it can never overflow. Runs on THIS
    # thread (no second timer) and self-throttles to hourly. Caps come from the
    # settings table so a SaaS-admin portal can tune them per plan without a
    # deploy. Independent of the master switch — pruning old audit rows is
    # housekeeping, not unattended WORK, and must keep the table bounded even
    # while automation is paused.
    if now - _last_purge >= _PURGE_INTERVAL:
        _last_purge = now
        try:
            rc = db.retention_config()
            db.job_runs_purge(rc["job_runs_days"], rc["job_runs_per_loop"])
            db.ui_events_purge(rc["ui_events_days"])
            db.canvas_tombstones_gc(CANVAS_TOMBSTONE_TTL)
        except Exception:
            pass
        # Credentials of runs this process never saw (they predate a restart)
        # are outside the per-job reaper above; sweep them once they are far
        # older than any run can live, so a dead session's token expires too.
        try:
            with CHAT_LOCK:
                live = list(CHAT_JOBS.keys())
            db.session_tokens_purge_stale(live, SESSION_TOKEN_MAX_AGE)
        except Exception:
            pass
    fire_due_loops(launch, now)
    # The hourly maintenance window (orchestrator.maintenance): applies queued
    # restart requests at :50. Not gated by the master switch — agents only
    # QUEUE restarts; applying them is the owner's standing policy (Card 133).
    try:
        from orchestrator import maintenance
        maintenance.tick(now)
    except Exception:
        pass
    # The 30-minute board sweep — a safety net for event wakes the action
    # path missed. Its wakes are agent-origin, so it only runs when the
    # autonomous side may act (master switch ON and the loop mode licenses
    # agent) — otherwise it would stamp the interval and drop the event
    # the wakes could never fire. Idle board = zero cost either way.
    try:
        from orchestrator import board_wake
        from orchestrator.orchestrator import automation_enabled, loop_mode
        autonomous = automation_enabled() and loop_mode() in ("agent", "both")
        if autonomous:
            board_wake.sweep()
        # Expired asks are always recorded (the session's inbox is the
        # durable record); only the resume is gated with the sweep.
        board_wake.expire_asks(now, wake=autonomous)
    except Exception:
        pass


def run_loop_iteration(session_id, rel_path, prompt, model="", provider="", on_done=None):
    """Fire one loop run against a session (used by the scheduler). Returns True if
    a run actually started. on_done(rc, detail) is called when the run finishes so
    the scheduler can record the outcome to job-run history; if the run can't start
    (missing file / session busy / unresolvable provider) it is called here with an
    error rc and False is returned, so no history row is left dangling."""
    if not rel_path:
        # The loop row carries no path (the MCP `path` field is optional): resolve
        # the transcript by session id — it is <project-dir>/<id>.jsonl under the
        # projects root (the same one-level glob the session-list code uses). The
        # claude CLI can't resume from a bare id in an arbitrary cwd, so an
        # unresolvable one-shot fails here, loudly, instead of resuming into a
        # foreign working directory and dying without a trace.
        path = transcript_path(session_id)
        if not path:
            if on_done:
                on_done(-1, f"session not found: {session_id} (loop has no path and no transcript)")
            return False
        rel_path = str(path.relative_to(CLAUDE_DIR.parent))
    full = CLAUDE_DIR.parent / rel_path
    if not full.is_file():
        if on_done:
            on_done(-1, f"session file missing: {rel_path}")
        return False
    cwd = extract_cwd(full)
    if not os.path.isdir(cwd):
        cwd = str(Path.home())
    from orchestrator import ai, providers
    try:
        resolved = ai.resolve(db.session_meta_get(session_id) or {}, model,
                              provider_override=provider, model_override=model)
    except ValueError as exc:
        if on_done:
            on_done(-1, str(exc))
        return False
    provider_env = None
    if resolved["provider"]:
        provider_env = providers.anthropic_env(resolved["provider"], model=resolved["model"],
                                               preset=resolved["preset"])
    return start_claude_run(session_id, ["--resume", session_id], prompt,
                            "acceptEdits", cwd, "" if provider_env else resolved["model"],
                            provider_env=provider_env, effort=resolved["effort"], on_done=on_done)
