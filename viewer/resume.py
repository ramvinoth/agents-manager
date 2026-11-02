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
Every harness records its turns: Claude (local and SSH, incl. Agent mode on a
custom Anthropic-compatible endpoint), custom-provider chat, Codex, Copilot and
Pi. The row's `agent` picks the launcher in _LAUNCHERS; the run-end self-resume
(was_cut_off) is Claude's only — the one-shot runners have no turn-open signal
to tell a cut from a failure, so they resume at boot only.
"""
import os
import time

from viewer import db

MAX_RESUMES = 2
BOOT_DELAY = 3  # seconds: the resumed run's permission tool calls back into this server

RESUME_PROMPT = (
    "Your last turn was cut off mid-way (the Manager server restarted, or the agent "
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
    """Re-launch one cut-off turn with the launcher of the harness that ran it."""
    launch = _LAUNCHERS.get(row.get("agent") or "claude")
    return bool(launch and launch(row))


def _cwd(row):
    """The recorded cwd; a local one that is gone falls back to home (Popen
    neither expands '~' nor survives a missing dir)."""
    cwd = row["cwd"] or "~"
    if (row["host"] or "local") != "local":
        return cwd
    cwd = os.path.expanduser(cwd)
    return cwd if os.path.isdir(cwd) else os.path.expanduser("~")


def _resume_turn(row):
    """Claude and custom-provider sessions: through turn.start_turn, the one
    place the composer launches them, so the AI selection (custom chat, Agent
    mode endpoint env, or plain Claude) is re-resolved, never stored. Then
    re-queue the messages that were waiting behind the cut turn."""
    from viewer.config import transcript_path
    from viewer.engine import enqueue_chat
    from viewer.turn import start_turn
    sid, host = row["session_id"], row["host"] or "local"
    if host == "local" and not transcript_path(sid):
        return False  # cut before its first transcript line: nothing to resume
    if start_turn(sid, RESUME_PROMPT, row["mode"] or "acceptEdits", row["cwd"] or "~",
                  row["model"], host) is not None:
        return False
    for msg in row.get("queue") or []:
        enqueue_chat(sid, msg)
    return True


def _resume_codex(row):
    from viewer.engine import start_codex_run
    codex_id = (row.get("ref") or {}).get("codex_id")
    return bool(codex_id) and start_codex_run(row["session_id"], codex_id, RESUME_PROMPT,
                                              _cwd(row), row["model"], row["host"] or "local")


def _resume_copilot(row):
    from viewer.engine import start_copilot_run
    return start_copilot_run(row["session_id"], RESUME_PROMPT, _cwd(row), row["host"] or "local",
                             row["model"], row["mode"])


def _resume_pi(row):
    from viewer.engine import start_pi_run
    ref = row.get("ref") or {}
    return bool(ref.get("uuid")) and start_pi_run(row["session_id"], ref["uuid"], RESUME_PROMPT,
                                                  _cwd(row), ref.get("provider", ""), row["model"])


# Harness (CHAT_JOBS "agent", recorded on the in-flight row) -> its resume launcher.
_LAUNCHERS = {"claude": _resume_turn, "custom": _resume_turn, "codex": _resume_codex,
              "copilot": _resume_copilot, "pi": _resume_pi}
