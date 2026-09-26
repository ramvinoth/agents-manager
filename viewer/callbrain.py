"""viewer.callbrain — the fast brain behind a phone call.

A call turn must answer in a couple of seconds, but the real work (files, email,
code) takes a Claude session minutes. So the brain is a small OpenAI-compatible
text model (the owner's chosen provider preset, stored in the `call_brain`
setting) with three tools that all return instantly:

  ask_harman(question)  hand the question to the bound Claude session as its next
                        turn (through viewer.turn.start_turn — the same launch path
                        the chat composer uses) and come straight back.
  check_harman()        what that session is doing right now, or its final answer.
  board_status()        the session's Kanban board: counts per column and the cards
                        that are moving or waiting on the owner.

The conversation memory of a call lives in the `history` the phone sends back
each turn (spoken turns plus the tool calls and results — see trim_history), so
the server holds no per-call state and a restart loses nothing.
Pure helpers (transcript activity, board summary, tool dispatch) take plain data
so they are unit-tested without a model or a database.
"""
import json
import time

from viewer import db, orglogic, providers
from viewer.config import CHAT_JOBS, CHAT_LOCK, read_back, split_lines, transcript_path
from viewer.customrun import chat_completion_message

SETTING_KEY = "call_brain"        # {"provider": <preset id>}
BRAIN_TIMEOUT = 25                # seconds per model call; a call cannot wait longer
MAX_TOOL_ROUNDS = 3
HISTORY_LIMIT = 24                # prior call messages replayed to the brain
ANSWER_CHARS = 700                # how much of a finished answer is read aloud

SYSTEM_PROMPT = (
    "You are Harman on a phone call with your owner. Speak in one or two short, "
    "natural sentences; no markdown, no lists. You cannot do any work yourself and "
    "have no data of your own. Anything about the owner's work, files, email, code, "
    "calendar, money, the weather, or any action MUST be delegated by calling the "
    "ask_harman tool with the request in the owner's words; only after the tool has "
    "returned may you say it has started. Saying 'started' without calling the tool "
    "is lying. You never know the state of that work yourself: every time they ask "
    "whether it is done, how it is going, or for the answer, call check_harman first "
    "and relay exactly what it returns. When they ask about the board, tasks or what "
    "is pending, call board_status. Never guess."
)

TOOLS = [
    {"type": "function", "function": {
        "name": "ask_harman",
        "description": "Hand a request to the Harman work session. Returns at once; "
                       "the work continues in the background.",
        "parameters": {"type": "object", "required": ["question"],
                       "properties": {"question": {"type": "string",
                                                   "description": "The request, in the owner's words."}}}}},
    {"type": "function", "function": {
        "name": "check_harman",
        "description": "Progress of the current request, or its final answer when done.",
        "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {
        "name": "board_status",
        "description": "Summary of the Kanban board: counts per column and the cards in motion.",
        "parameters": {"type": "object", "properties": {}}}},
]


# ---------------------------------------------------------------- pure helpers

def transcript_activity(lines):
    """From transcript JSONL lines (oldest first): the latest assistant text and
    the latest tool call, whichever records exist. Tool results and meta records
    are ignored — the caller wants what Harman said and what it is doing."""
    text, tool = "", ""
    for line in lines:
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if obj.get("type") != "assistant":
            continue
        content = (obj.get("message") or {}).get("content") or []
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text" and block.get("text", "").strip():
                text = " ".join(block["text"].split())
            elif block.get("type") == "tool_use":
                tool = block.get("name", "")
    return {"text": text, "tool": tool}


def describe_run(job, activity, now=None):
    """One spoken sentence about the bound session's run. `job` is the CHAT_JOBS
    entry (or None), `activity` comes from transcript_activity."""
    if not job:
        return "No request has been started on this call."
    if job.get("running"):
        elapsed = int((now or time.time()) - job.get("started", 0))
        if job.get("pending_approvals"):
            return (f"Harman has been working for {elapsed} seconds and is waiting for "
                    "your approval of a tool in the app.")
        step = f", currently using {activity['tool']}" if activity.get("tool") else ""
        return f"Harman is still working, {elapsed} seconds so far{step}."
    if job.get("returncode") not in (0, None):
        return "The last request ended with an error: " + (job.get("stderr") or "no detail")[-200:]
    answer = activity.get("text") or ""
    if not answer:
        return "Harman finished but wrote no answer."
    if len(answer) > ANSWER_CHARS:
        answer = answer[:ANSWER_CHARS].rsplit(" ", 1)[0] + "… the rest is in the chat."
    return "Harman finished. " + answer


_MOVING = ("Doing", "Review", "Needs-info", "Blocked")


def summarize_board(columns, cards, per_column=4):
    """Spoken board summary from raw column and card rows: a count per non-empty
    column, then the titles in the columns that mean 'in motion' or 'waiting on
    you'. Done is counted but never listed."""
    by_col = {}
    for card in cards:
        by_col.setdefault(card.get("column_id"), []).append(card)
    counts, listed = [], []
    for col in sorted(columns, key=lambda c: c.get("position", 0)):
        mine = by_col.get(col["id"], [])
        if not mine:
            continue
        counts.append(f"{len(mine)} in {col['name']}")
        if col["name"] in _MOVING:
            titles = [c.get("title", "") for c in mine[:per_column]]
            more = f" and {len(mine) - per_column} more" if len(mine) > per_column else ""
            listed.append(f"{col['name']}: " + "; ".join(titles) + more)
    if not counts:
        return "The board is empty."
    return "Board: " + ", ".join(counts) + ". " + " ".join(listed)


def parse_tool_calls(message):
    """(name, args dict, call id) for each tool call in an OpenAI reply message."""
    out = []
    for call in message.get("tool_calls") or []:
        fn = call.get("function") or {}
        try:
            args = json.loads(fn.get("arguments") or "{}")
        except Exception:
            args = {}
        out.append((fn.get("name", ""), args if isinstance(args, dict) else {}, call.get("id", "")))
    return out


# ------------------------------------------------------------ tool executors

def brain_preset():
    """The provider preset the call brain runs on, or None when the owner has not
    chosen one (`call_brain` setting) or it no longer exists."""
    pid = (db.setting_get(SETTING_KEY) or {}).get("provider")
    preset = providers.get_preset(pid) if pid else None
    return preset if preset and preset.get("baseUrl") else None


def _ask_harman(sid, cwd, mode, question):
    from viewer.turn import start_turn
    if not question.strip():
        return "Nothing to ask."
    failure = start_turn(sid, question.strip(), mode, cwd)
    if failure and failure[0] == 409:
        return "Harman is still busy with the previous request; check on it first."
    if failure:
        return "Could not start: " + failure[1]
    return "Started. The work is running in the background."


def _check_harman(sid):
    with CHAT_LOCK:
        job = dict(CHAT_JOBS.get(sid) or {})
    activity = {"text": "", "tool": ""}
    path = transcript_path(sid)
    if path:
        base, data = read_back(path, path.stat().st_size, 80)
        activity = transcript_activity(split_lines(data, base)[0])
    return describe_run(job or None, activity)


def _board_status(sid):
    meta = db.session_meta_get(sid) or {}
    project = orglogic.resolve_board_project(None, meta.get("kanbanProject"))
    if project is None:
        return "This session has no board attached."
    return summarize_board(db.board_columns_list(project), db.card_list(project_id=project))


def run_tool(name, args, sid, cwd, mode):
    if name == "ask_harman":
        return _ask_harman(sid, cwd, mode, str(args.get("question", "")))
    if name == "check_harman":
        return _check_harman(sid)
    if name == "board_status":
        return _board_status(sid)
    return f"Unknown tool {name}."


# ------------------------------------------------------------------ the turn

def call_turn(sid, cwd, mode, text, history, preset=None, tool_runner=run_tool):
    """One spoken exchange. Returns {"reply", "history", "tools"} — the phone
    speaks `reply`, stores `history` for the next turn, and may show `tools`
    (the tool names that ran) as a hint. Raises RuntimeError when no brain is
    configured; transport errors from the model propagate to the route."""
    preset = preset or brain_preset()
    if not preset:
        raise RuntimeError("No call brain configured: set the call_brain setting to a provider preset")
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    messages += [m for m in (history or []) if isinstance(m, dict) and m.get("role") in _ROLES]
    messages.append({"role": "user", "content": text})
    used = []
    reply = ""
    for _ in range(MAX_TOOL_ROUNDS + 1):
        message = chat_completion_message(
            preset["baseUrl"], preset.get("apiKey", ""),
            {"model": preset.get("model", ""), "messages": messages, "tools": TOOLS,
             "max_tokens": 200, "chat_template_kwargs": {"enable_thinking": False}},
            timeout=BRAIN_TIMEOUT)
        calls = parse_tool_calls(message)
        reply = (message.get("content") or "").strip()
        if not calls:
            break
        messages.append({"role": "assistant", "content": message.get("content") or None,
                         "tool_calls": message.get("tool_calls")})
        for name, args, call_id in calls:
            used.append(name)
            messages.append({"role": "tool", "tool_call_id": call_id, "name": name,
                             "content": tool_runner(name, args, sid, cwd, mode)})
    else:
        reply = reply or "I lost the thread there; could you say that again?"
    messages.append({"role": "assistant", "content": reply})
    return {"reply": reply, "history": trim_history(messages[1:]), "tools": used}


_ROLES = ("user", "assistant", "tool")


def trim_history(messages, limit=HISTORY_LIMIT):
    """The last `limit` messages, cut on a user turn so an assistant tool_call is
    never separated from its tool results (the template rejects an orphan).
    Tool traffic is KEPT: measured on Qwen 27B, a history of spoken turns only
    made the model announce 'I've started…' without calling the tool 5 times in
    20; with the calls and results in view it was 0 in 20."""
    if len(messages) <= limit:
        return list(messages)
    tail = messages[-limit:]
    for i, m in enumerate(tail):
        if m.get("role") == "user":
            return list(tail[i:])
    return []
