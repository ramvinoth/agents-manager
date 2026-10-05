"""viewer.resume — a server restart pauses agent turns instead of killing them.

A restart (planned update, crash, launchd kickstart) takes every running claude
child down with the server process. engine.start_claude_run records each turn in
`inflight_runs` and deletes the row when the turn ends on its own, so whatever
is still there at boot was cut off by the restart. resume_inflight() re-launches
each of those sessions with RESUME_PROMPT (verified 2026-10-04: a resumed claude
told this checks what really finished and redoes only the rest), then hands it
the messages that were queued behind the cut turn.

Not resumed:
- a session with an open question/plan: it is waiting on the owner, and the
  answer already resumes it (routes/chat._resume_with_reply);
- a turn already auto-resumed MAX_RESUMES times without ending: it may be what
  keeps taking the server down, so the owner is told instead.
Claude runs only (local and SSH hosts); the codex/copilot/pi/custom-chat runners
do not record in-flight turns.
"""
import time

from viewer import db

MAX_RESUMES = 2
BOOT_DELAY = 3  # seconds: the resumed run's permission tool calls back into this server

RESUME_PROMPT = (
    "The Harman server restarted (an update or a crash) while your last turn was "
    "running, so that turn was cut off mid-way. Check what actually completed before "
    "the cut (files, commands, background jobs) and then finish the task. Do not "
    "repeat a step that already finished.")


def _waiting_on_owner(session_id):
    from viewer import questions
    return bool(db.pending_question_get_open(session_id) or questions.get_open_plan(session_id))


def _tell_owner(session_id, body):
    from viewer import inbox
    inbox.deliver_message("session", session_id, "user", "", body, wake=False)


def resume_inflight(start=None, sleep=time.sleep):
    """Resume every turn the last restart cut off. Returns the resumed session
    ids. `start(row) -> bool` launches one resumed turn (injected in tests)."""
    start = start or _start
    sleep(BOOT_DELAY)
    resumed = []
    for row in db.inflight_runs_all():
        sid = row["session_id"]
        try:
            if _waiting_on_owner(sid):
                db.inflight_run_clear(sid)
                continue
            if row["resumes"] >= MAX_RESUMES:
                db.inflight_run_clear(sid)
                _tell_owner(sid, (
                    "Should I keep retrying my last task? The Harman server restarted "
                    f"{row['resumes'] + 1} times while it was running, so I stopped "
                    "resuming it automatically in case it is what crashes the server. "
                    "Reply in this chat to continue."))
                continue
            db.inflight_run_bump_resumes(sid)
            if start(row):
                resumed.append(sid)
            else:
                db.inflight_run_clear(sid)
        except Exception as e:
            print(f"  ⚠ could not resume interrupted turn {sid[:8]}: {e}")
    return resumed


def _start(row):
    """Re-launch one cut-off turn through the same selection the composer uses
    (the provider env is re-resolved, never stored), then re-queue its backlog."""
    from viewer import ai, providers
    from viewer.config import transcript_path
    from viewer.engine import start_claude_run, enqueue_chat
    sid, host = row["session_id"], row["host"] or "local"
    if host == "local" and not transcript_path(sid):
        return False  # cut before its first transcript line: nothing to resume
    resolved = ai.resolve(db.session_meta_get(sid) or {}, row["model"], host)
    provider_env = None
    if resolved["provider"]:
        provider_env = providers.anthropic_env(resolved["provider"], model=resolved["model"],
                                               preset=resolved["preset"])
    if not start_claude_run(sid, ["--resume", sid], RESUME_PROMPT, row["mode"] or "acceptEdits",
                            row["cwd"] or "~", "" if provider_env else resolved["model"], host,
                            provider_env=provider_env, effort=resolved["effort"]):
        return False
    for msg in row.get("queue") or []:
        enqueue_chat(sid, msg)
    return True
