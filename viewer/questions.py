"""viewer.questions — async AskUserQuestion lifecycle (detect / persist / resume).

A driven `claude -p` run cannot answer AskUserQuestion (no interactive UI), so the
tool returns an error and the turn ends. Rather than block a live subprocess, we
DETECT that terminal-unanswered-question from the transcript when the run finishes,
persist it as a durable row (viewer.db.pending_questions), show the app a card, and
— when the user answers — RESUME the same session via `claude --resume` with the
pick as the next message. Works in every permission mode; survives restarts.

This module is pure/host-agnostic at the boundary: `detect_pending` takes the
already-read transcript records so it's trivially unit-testable; the thin DB
wrappers and the compose helper carry no HTTP/threading knowledge.
"""
import json

from viewer import db
from viewer.config import CLAUDE_DIR

# Tool-result strings the headless CLI returns when AskUserQuestion has no
# interactive answerer. Matched loosely (substring/prefix) since the CLI also
# emits validation errors and a timeout variant — all mean "unanswered here".
_NO_ANSWER_MARKERS = ("answer questions?", "did not answer", "no response")


def _result_is_unanswered(content):
    """True if a tool_result content marks an AskUserQuestion left unanswered by
    the (non-interactive) CLI, rather than a real answer."""
    text = content if isinstance(content, str) else json.dumps(content)
    low = text.lower()
    return any(m in low for m in _NO_ANSWER_MARKERS)


def read_transcript(session_id, host="local"):
    """Parsed JSONL records for a session, local or remote, or [] if not found /
    unreadable. Detection only needs the tail; kept resilient so a transcript read
    can never crash the run-finish hook.
    """
    if host and host != "local":
        return _read_remote_transcript(session_id, host)
    matches = list(CLAUDE_DIR.glob(f"*/{session_id}.jsonl"))
    if not matches:
        return []
    try:
        with open(matches[0], errors="replace") as f:
            return _parse_lines(f)
    except OSError:
        return []


def _read_remote_transcript(session_id, host):
    """Read a remote session's transcript tail over SSH, reusing the viewer's
    remote helpers. Returns parsed records, or [] on any SSH/lookup failure."""
    try:
        from viewer.remote import remote_read_session, remote_resolve
        r = remote_resolve(host, session_id)
        rel = r.get("path") if isinstance(r, dict) else None
        if not rel:
            return []
        env = remote_read_session(host, rel, {"tail": ["400"]})
        lines = env.get("lines") if isinstance(env, dict) else None
        return _parse_lines(lines or [])
    except Exception:
        return []


def _parse_lines(lines):
    """Parse an iterable of JSONL strings into record dicts, skipping bad lines."""
    out = []
    for line in lines:
        line = (line or "").strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def detect_pending(records):
    """Given a session's transcript records (oldest→newest), return
    {tool_use_id, questions} iff the run ended waiting on an unanswered
    AskUserQuestion — i.e. the LAST AskUserQuestion tool_use got an "unanswered"
    error result AND no real human message followed it (which would mean the user
    already answered, e.g. via a resumed run). Else None. Pure function — no I/O.
    """
    # 1. Locate the last AskUserQuestion tool_use (index + input).
    last_auq_id = None
    last_auq_input = None
    last_auq_idx = -1
    for i, rec in enumerate(records):
        for b in _blocks(rec):
            if b.get("type") == "tool_use" and b.get("name") == "AskUserQuestion":
                last_auq_id = b.get("id")
                last_auq_input = b.get("input")
                last_auq_idx = i
    if not last_auq_id:
        return None

    # 2. Its tool_result must exist and be an "unanswered" error.
    result_idx = -1
    result_content = None
    for i, rec in enumerate(records):
        for b in _blocks(rec):
            if b.get("type") == "tool_result" and b.get("tool_use_id") == last_auq_id:
                result_idx = i
                result_content = b.get("content")
    if result_idx < 0 or not _result_is_unanswered(result_content):
        return None

    # 3. Guard against re-detecting an already-answered question: if any real human
    #    message (a `user` record carrying text, not just a tool_result) appears
    #    after the AUQ result, the user has moved the conversation on.
    for rec in records[result_idx + 1:]:
        if rec.get("type") == "user" and _has_human_text(rec):
            return None

    # 4. Extract the questions array (input may be an object or a JSON string).
    questions = _questions_from_input(last_auq_input)
    if not questions:
        return None
    return {"tool_use_id": last_auq_id, "questions": questions}


def _blocks(rec):
    """The content blocks of a transcript record, or [] — normalises the
    message.content shape so callers don't repeat the guards."""
    content = (rec.get("message") or {}).get("content")
    return content if isinstance(content, list) else []


def _has_human_text(rec):
    """True if a `user` record carries a real typed message (text block or a
    plain string), as opposed to only tool_result blocks."""
    content = (rec.get("message") or {}).get("content")
    if isinstance(content, str):
        return bool(content.strip())
    if isinstance(content, list):
        return any(isinstance(b, dict) and b.get("type") == "text" and (b.get("text") or "").strip()
                   for b in content)
    return False


def _questions_from_input(tinput):
    """Pull the `questions` list out of an AskUserQuestion tool input, tolerating
    a JSON-string input. Returns [] if malformed."""
    if isinstance(tinput, str):
        try:
            tinput = json.loads(tinput)
        except (json.JSONDecodeError, TypeError):
            return []
    if isinstance(tinput, dict):
        qs = tinput.get("questions")
        return qs if isinstance(qs, list) else []
    return []


# Public alias — the engine's blocking AUQ handler needs to extract the questions
# from a live tool input (same logic as detection uses).
questions_from_input = _questions_from_input


def answer_message(questions, picks):
    """Compose the message fed back to the resumed session. `picks` is a list of
    selected option labels, positionally aligned with `questions`. Server-side and
    authoritative (the client sends only the picks, not free text).
    """
    parts = []
    for i, q in enumerate(questions):
        chosen = picks[i] if i < len(picks) else ""
        if not chosen:
            continue
        header = (q.get("header") or q.get("question") or "").strip()
        parts.append(f'{header}: {chosen}' if header else chosen)
    body = "\n".join(parts) if parts else "(no selection)"
    return f"My answer to your question — {body}"


# ---- thin DB wrappers (single source of truth = viewer.db) ----------------------

def record(session_id, pending, host="local"):
    db.pending_question_set(session_id, pending["tool_use_id"], pending["questions"], host)


def get_open(session_id):
    return db.pending_question_get_open(session_id)


def resolve(session_id, tool_use_id):
    return db.pending_question_resolve(session_id, tool_use_id)


def clear(session_id):
    db.pending_question_delete(session_id)


# ---- plans (ExitPlanMode) — thin DB wrappers -----------------------------------

def record_plan(session_id, pending, host="local"):
    db.pending_plan_set(session_id, pending["tool_use_id"], pending["plan"], host)


def get_open_plan(session_id):
    return db.pending_plan_get_open(session_id)


def clear_plan(session_id):
    db.pending_plan_delete(session_id)
