"""viewer.resume — a cut-off agent turn is resumed, not dropped.

A turn can end before it finishes without anyone asking it to: a server
restart (update, crash, kickstart) takes every claude child down with it, and
a run can die on its own mid-turn (the CLI crashes, the process is killed, the
idle timeout fires). engine.start_claude_run records each turn in
`inflight_runs` and deletes the row when the turn ends on its own, so:

- at boot, every row still there was cut off by the restart: resume_inflight();
- at run end, the finalizer asks was_cut_off() and, if so, resume_one().

Either way the session is re-launched with RESUME_PROMPT (verified 2026-10-04:
a resumed claude told this checks what really finished and redoes only the
rest), then handed the messages queued behind the cut turn. The owner no
longer has to type "Continue".

Not resumed:
- a session with an open question/plan: it is waiting on the owner, and the
  answer already resumes it (routes/chat._resume_with_reply);
- a turn already auto-resumed MAX_RESUMES times without ending: something about
  it keeps cutting it off (or taking the server down), so the owner is told.
  The counter lives on the row and resets only when a turn ends normally.
Claude runs only (local and SSH hosts); the codex/copilot/pi/custom-chat runners
do not record in-flight turns.
"""
import time

from viewer import db

MAX_RESUMES = 2
BOOT_DELAY = 3  # seconds: the resumed run's permission tool calls back into this server

RESUME_PROMPT = (
    "Your last turn was cut off mid-way (the Harman server restarted, or the agent "
    "process was stopped) before it finished. Check what actually completed before "
    "the cut (files, commands, background jobs) and then finish the task. Do not "
    "repeat a step that already finished.")


def _waiting_on_owner(session_id):
    from viewer import questions
    return bool(db.pending_question_get_open(session_id) or questions.get_open_plan(session_id))


def _tell_owner(session_id, body):
    from viewer import inbox
    inbox.deliver_message("session", session_id, "user", "", body, wake=False)


def was_cut_off(turn_open, interrupted, explained):
    """Did a run end mid-turn without anyone deciding it should? `turn_open`:
    the last message sent got no result. An interrupt is the owner's call, and an
    explained stop (unreachable model server, too-old CLI) was already pushed to
    the owner with what to do — resuming would only hit the same wall."""
    return bool(turn_open and not interrupted and not explained)


def capped(row):
    """Has this turn used up its automatic resumes (the owner gets asked instead)?"""
    return row["resumes"] >= MAX_RESUMES


def resume_one(row, start=None, reason=""):
    """Resume one cut-off turn from its in-flight row, within MAX_RESUMES.
    Returns True if a resumed run started; otherwise the row is cleared.
    `start(row) -> bool` launches it (injected in tests). `reason` is the last
    run's error, quoted to the owner when the cap is hit."""
    start = start or _start
    sid = row["session_id"]
    if _waiting_on_owner(sid):
        db.inflight_run_clear(sid, row["started_at"])
        return False
    if capped(row):
        db.inflight_run_clear(sid, row["started_at"])
        cause = (f"The last error was: {reason.strip()[-300:]}" if reason.strip()
                 else "The cause was a server restart or the agent process stopping.")
        _tell_owner(sid, (
            "Should I keep retrying my last task? It was cut off "
            f"{row['resumes'] + 1} times in a row before it finished, so I stopped "
            f"resuming it automatically in case something about it keeps causing that. "
            f"{cause} Reply in this chat to continue."))
        return False
    db.inflight_run_bump_resumes(sid)
    if start(row):
        return True
    db.inflight_run_clear(sid, row["started_at"])
    return False


def resume_inflight(start=None, sleep=time.sleep):
    """At boot: resume every turn the last restart cut off. Returns the resumed
    session ids."""
    sleep(BOOT_DELAY)
    resumed = []
    for row in db.inflight_runs_all():
        try:
            if resume_one(row, start):
                resumed.append(row["session_id"])
        except Exception as e:
            print(f"  ⚠ could not resume interrupted turn {row['session_id'][:8]}: {e}")
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
