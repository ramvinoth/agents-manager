"""viewer.callbrain — the fast brain behind a phone call.

A call turn must answer in a couple of seconds, but the real work (files, email,
code) takes a Claude session minutes. So the brain is a small OpenAI-compatible
text model (the owner's chosen provider preset, stored in the `call_brain`
setting) that talks over the BOARD — the same ledger every session and the
owner already use — never a private side channel:

  The snapshot   Every turn's system prompt carries a live snapshot of the
                 system (clock, who is speaking, board counts, the cards waiting
                 on the owner with their age, open approvals, what the bound
                 work session is doing). Most questions on a call — "what is
                 the date", "what is waiting on me", "is 53 done" — are
                 answered from it with no tool call at all.
  delegate       Create a card in Todo, bound to the work session; the board
                 follow-up wakes that session (boardwatch), exactly as if the
                 owner had typed the card. The request survives the call.
  card_detail    A card's column, age and latest comments — how work is checked.
  comment        The owner's spoken note, on the card's thread.
  decide         The owner's judgement: move a card to Approved or Declined.
  board_status   Every open card by column, when the snapshot's top few are
                 not enough.

Every write goes through actions.execute under the CALLER's principal — the
human on the phone — so authority, audit and wakes are the ones the board
already enforces; the brain adds no policy of its own.

The conversation memory of a call lives in the `history` the phone sends back
each turn (spoken turns plus the tool calls and results — see trim_history), so
the server holds no per-call state and a restart loses nothing. Pure helpers
(snapshot rendering, transcript activity, tool-call parsing) take plain data so
they are unit-tested without a model or a database.
"""
import json
import time
from datetime import datetime

from viewer import actions, db, orglogic, providers
from viewer.config import CHAT_JOBS, CHAT_LOCK, read_back, split_lines, transcript_path
from viewer.customrun import chat_completion_message

SETTING_KEY = "call_brain"        # {"provider": <preset id>}
ENGINE_KEY = "call_engine"        # "brain" (default) | "nemotron" — the owner's opt-in
BRAIN_TIMEOUT = 25                # seconds per model call; a call cannot wait longer
MAX_TOOL_ROUNDS = 3
HISTORY_LIMIT = 24                # prior call messages replayed to the brain
ANSWER_CHARS = 700                # how much of a finished answer is read aloud
SNAPSHOT_PER_COLUMN = 3           # cards named per waiting column in the snapshot

PERSONA = (
    "You are Harman, on a phone call with the owner of this system. Speak in one or "
    "two short natural sentences; no markdown, no lists, say card numbers as plain "
    "numbers. Harman is an organisation of AI agents that do the owner's work; the "
    "Kanban board is the ledger where work is delegated, tracked and decided. The "
    "SYSTEM SNAPSHOT below is live and authoritative: answer the date, the time, what "
    "is pending, what is waiting on the owner, and what Harman is doing straight from "
    "it. Any new request for work — files, email, code, research, anything to do — "
    "MUST become a card: call delegate with a clear title and the request in the "
    "owner's words; only after the tool returns may you say it is delegated. Saying "
    "it is started without calling the tool is lying. To check on a card, call "
    "card_detail. When the owner approves or declines a card, call decide. When they "
    "want a note left on a card, call comment. For the full list of open cards, call "
    "board_status. Never invent card numbers or work that is not in the snapshot or a "
    "tool result."
)

TOOLS = [
    {"type": "function", "function": {
        "name": "delegate",
        "description": "Create a card on the board for the work session to do. Returns the card number.",
        "parameters": {"type": "object", "required": ["title", "detail"],
                       "properties": {"title": {"type": "string",
                                                "description": "Short imperative title, under 80 characters."},
                                      "detail": {"type": "string",
                                                 "description": "The request in the owner's own words, with any specifics they gave."}}}}},
    {"type": "function", "function": {
        "name": "card_detail",
        "description": "A card's column, how long it has been there, and its latest comments.",
        "parameters": {"type": "object", "required": ["card_id"],
                       "properties": {"card_id": {"type": "integer"}}}}},
    {"type": "function", "function": {
        "name": "comment",
        "description": "Leave the owner's spoken note on a card's thread.",
        "parameters": {"type": "object", "required": ["card_id", "text"],
                       "properties": {"card_id": {"type": "integer"},
                                      "text": {"type": "string"}}}}},
    {"type": "function", "function": {
        "name": "decide",
        "description": "Record the owner's decision on a card: move it to Approved or Declined.",
        "parameters": {"type": "object", "required": ["card_id", "decision"],
                       "properties": {"card_id": {"type": "integer"},
                                      "decision": {"type": "string", "enum": ["approved", "declined"]}}}}},
    {"type": "function", "function": {
        "name": "board_status",
        "description": "Every open card on the board, grouped by column.",
        "parameters": {"type": "object", "properties": {}}}},
]


# ---------------------------------------------------------------- pure helpers

def age(seconds):
    """A spoken age: '3 minutes', '2 hours', '4 days'."""
    seconds = max(0, int(seconds))
    if seconds < 3600:
        n, unit = max(1, seconds // 60), "minute"
    elif seconds < 86400:
        n, unit = seconds // 3600, "hour"
    else:
        n, unit = seconds // 86400, "day"
    return f"{n} {unit}{'' if n == 1 else 's'}"


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
        return "The work session is idle."
    if job.get("running"):
        elapsed = int((now or time.time()) - job.get("started", 0))
        if job.get("pending_approvals"):
            return (f"The work session has been working for {elapsed} seconds and is waiting "
                    "for the owner to approve a tool in the app.")
        step = f", currently using {activity['tool']}" if activity.get("tool") else ""
        return f"The work session is working, {elapsed} seconds so far{step}."
    if job.get("returncode") not in (0, None):
        return "The work session's last run ended with an error: " + (job.get("stderr") or "no detail")[-200:]
    answer = activity.get("text") or ""
    if not answer:
        return "The work session is idle."
    if len(answer) > ANSWER_CHARS:
        answer = answer[:ANSWER_CHARS].rsplit(" ", 1)[0] + "… the rest is in the chat."
    return "The work session is idle; its last words were: " + answer


# Columns that mean "waiting on the owner" (a decision or a fact) — named in
# the snapshot so the owner hears what needs THEM first — and the ones that
# mean "in motion". Done is counted, never listed.
_WAITING_ON_OWNER = ("Review", "Needs-info")
_IN_MOTION = ("Doing", "Blocked")


def _by_column(columns, cards):
    by_col = {}
    for card in cards:
        by_col.setdefault(card.get("column_id"), []).append(card)
    ordered = sorted(columns, key=lambda c: c.get("position", 0))
    return [(col, by_col.get(col["id"], [])) for col in ordered]


def _card_line(card, now):
    return f"#{card.get('id')} \"{card.get('title', '')}\" ({age(now - float(card.get('updated_at') or now))})"


def render_snapshot(now, speaker, project_name, columns, cards, approvals_open, run_sentence,
                    per_column=SNAPSHOT_PER_COLUMN):
    """The live system snapshot the brain answers from. `now` is an aware local
    datetime; `cards`/`columns` are raw rows (None when the session has no
    board); `run_sentence` comes from describe_run."""
    lines = [f"Now: {now.strftime('%A, %B %-d, %Y, %-I:%M %p %Z')}.",
             f"Speaking with: {speaker}."]
    if columns is None:
        lines.append("Board: this call's session has no board attached; delegate is unavailable.")
    else:
        groups = _by_column(columns, cards)
        counts = [f"{len(mine)} {col['name']}" for col, mine in groups if mine]
        lines.append(f"Board '{project_name}': " + (", ".join(counts) if counts else "empty") + ".")
        ts = now.timestamp()
        for label, names in (("Waiting on the owner", _WAITING_ON_OWNER), ("In motion", _IN_MOTION)):
            parts = []
            for col, mine in groups:
                if col["name"] not in names or not mine:
                    continue
                mine = sorted(mine, key=lambda c: float(c.get("updated_at") or 0))
                shown = "; ".join(_card_line(c, ts) for c in mine[:per_column])
                more = f" and {len(mine) - per_column} more" if len(mine) > per_column else ""
                parts.append(f"{col['name']} — {shown}{more}")
            if parts:
                lines.append(f"{label}: " + ". ".join(parts) + ".")
    if approvals_open:
        lines.append(f"Open tool approvals waiting on the owner in the app: {approvals_open}.")
    lines.append(run_sentence)
    return "\n".join(lines)


def render_board(columns, cards, now):
    """Every open card by column, for the board_status tool."""
    out = []
    for col, mine in _by_column(columns, cards):
        if not mine or col["name"].lower() == "done":
            continue
        out.append(f"{col['name']} ({len(mine)}): " + "; ".join(_card_line(c, now) for c in mine))
    return " ".join(out) or "The board has no open cards."


def render_card(card, column_name, comments, deps, now):
    """One card, spoken: where it is, since when, what blocks it, the latest
    comments (newest last)."""
    where = column_name or "no column"
    text = (f"Card {card['id']} \"{card.get('title', '')}\" is in {where}, last changed "
            f"{age(now - float(card.get('updated_at') or now))} ago.")
    open_deps = [d for d in deps if not d.get("done")]
    if open_deps:
        text += " Blocked by " + ", ".join(f"card {d['id']} \"{d.get('title', '')}\"" for d in open_deps) + "."
    if comments:
        recent = comments[-3:]
        text += " Latest comments: " + " | ".join(
            f"{c.get('author', '')} ({age(now - float(c.get('created_at') or now))} ago): "
            f"{' '.join(str(c.get('body', '')).split())[:300]}" for c in recent)
    else:
        text += " No comments yet."
    return text


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


# ------------------------------------------------------------ live data

def choose_engine(setting, nemotron_on, preset):
    """Which engine a phone call runs on — decided HERE, never by the phone.
    The board-grounded brain is the default because it is the only path that
    can answer from the snapshot; Nemotron VoiceChat (raw audio in and out, no
    prompt, no tools in the committed service) is an opt-in experiment behind
    the `call_engine` setting, and only when its service is configured."""
    if setting == "nemotron" and nemotron_on:
        return {"engine": "nemotron"}
    if not preset:
        return {"engine": "brain",
                "error": "No call brain configured: set the call_brain setting to a provider preset"}
    return {"engine": "brain", "model": preset.get("name") or preset.get("model") or ""}


def engine():
    from viewer import nemotron
    return choose_engine(db.setting_get(ENGINE_KEY) or "brain", nemotron.enabled(), brain_preset())


def brain_preset():
    """The provider preset the call brain runs on, or None when the owner has not
    chosen one (`call_brain` setting) or it no longer exists."""
    pid = (db.setting_get(SETTING_KEY) or {}).get("provider")
    preset = providers.get_preset(pid) if pid else None
    return preset if preset and preset.get("baseUrl") else None


def _project_of(sid):
    meta = db.session_meta_get(sid) or {}
    return orglogic.resolve_board_project(None, meta.get("kanbanProject"))


def _run_sentence(sid):
    with CHAT_LOCK:
        job = dict(CHAT_JOBS.get(sid) or {})
    activity = {"text": "", "tool": ""}
    path = transcript_path(sid)
    if path:
        base, data = read_back(path, path.stat().st_size, 80)
        activity = transcript_activity(split_lines(data, base)[0])
    return describe_run(job or None, activity)


def snapshot(sid, principal, now=None):
    """The rendered live snapshot for this call turn."""
    now = now or datetime.now().astimezone()
    project = _project_of(sid)
    columns = cards = None
    name = ""
    if project is not None:
        columns = db.board_columns_list(project)
        cards = db.card_list(project_id=project)
        name = (db.project_get(project) or {}).get("name") or str(project)
    return render_snapshot(now, principal.get("actor", "the owner"), name, columns, cards,
                           len(db.approval_list_open()), _run_sentence(sid))


# ------------------------------------------------------------ tool executors

def _execute(ctx, action, args):
    """One board write under the caller's own authority — the gate every other
    client uses, so the phone can never do more than its speaker could in the app."""
    p = ctx["principal"]
    payload, status = actions.execute(actions.intent(action, args, p["actor"]),
                                      p.get("human_role", ""), p.get("session_level", ""),
                                      acting_session=p.get("session", ""))
    return payload or {}, status


def _delegate(ctx, title, detail):
    title = " ".join(title.split())[:120]
    if not title:
        return "A title is needed to delegate."
    project = _project_of(ctx["sid"])
    if project is None:
        return "This call's session has no board, so nothing can be delegated."
    payload, status = _execute(ctx, "card_create",
                               {"title": title, "body": detail.strip(), "project_id": project,
                                "session": ctx["sid"], "created_by": ctx["principal"]["actor"]})
    if payload.get("error") or status != 200:
        return "Could not create the card: " + str(payload.get("error") or payload.get("reason") or status)
    return f"Delegated as card {payload.get('id')} in Todo; the work session will be woken to pick it up."


def _card_detail(ctx, card_id):
    card = db.card_get(card_id)
    if not card:
        return f"There is no card {card_id}."
    cols = db.board_columns_list(card["project_id"]) if card.get("project_id") else []
    col = next((c["name"] for c in cols if c["id"] == card.get("column_id")), "")
    return render_card(card, col, db.card_comment_list(card["id"]),
                       db.card_deps_batch([card["id"]]).get(card["id"], []), time.time())


def _comment(ctx, card_id, text):
    if not db.card_get(card_id):
        return f"There is no card {card_id}."
    payload, status = _execute(ctx, "card_comment",
                               {"card_id": card_id, "body": f"(by phone) {text.strip()}",
                                "author": ctx["principal"]["actor"]})
    if payload.get("error") or status != 200:
        return "Could not comment: " + str(payload.get("error") or payload.get("reason") or status)
    return f"Noted on card {card_id}."


def _decide(ctx, card_id, decision):
    card = db.card_get(card_id)
    if not card:
        return f"There is no card {card_id}."
    decision = (decision or "").strip().lower()
    cols = db.board_columns_list(card["project_id"]) if card.get("project_id") else []
    target = next((c for c in cols if c["name"].lower() == decision), None)
    if not target:
        return f"This board has no {decision or 'such'} column; decisions must be approved or declined."
    payload, status = _execute(ctx, "card_move", {"card_id": card_id, "column_id": target["id"]})
    if payload.get("error") or status != 200:
        return "Could not record it: " + str(payload.get("error") or payload.get("reason") or status)
    return f"Card {card_id} is now {target['name']}; its session will be woken."


def _board_status(ctx):
    project = _project_of(ctx["sid"])
    if project is None:
        return "This session has no board attached."
    return render_board(db.board_columns_list(project), db.card_list(project_id=project), time.time())


def _int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def run_tool(name, args, ctx):
    """Dispatch one tool call. `ctx` = {"sid", "principal"}."""
    if name == "delegate":
        return _delegate(ctx, str(args.get("title", "")), str(args.get("detail", "")))
    if name == "board_status":
        return _board_status(ctx)
    card_id = _int(args.get("card_id"))
    if name in ("card_detail", "comment", "decide") and card_id is None:
        return "Which card number?"
    if name == "card_detail":
        return _card_detail(ctx, card_id)
    if name == "comment":
        return _comment(ctx, card_id, str(args.get("text", "")))
    if name == "decide":
        return _decide(ctx, card_id, str(args.get("decision", "")))
    return f"Unknown tool {name}."


# ------------------------------------------------------------------ the turn

def system_prompt(snapshot_text):
    return PERSONA + "\n\nSYSTEM SNAPSHOT\n" + snapshot_text


def call_turn(sid, principal, text, history, preset=None, tool_runner=run_tool, snapshot_text=None):
    """One spoken exchange. Returns {"reply", "history", "tools"} — the phone
    speaks `reply`, stores `history` for the next turn, and may show `tools`
    (the tool names that ran) as a hint. `principal` is the caller's resolved
    principal (server.principal); every write runs under it. Raises RuntimeError
    when no brain is configured; transport errors from the model propagate."""
    preset = preset or brain_preset()
    if not preset:
        raise RuntimeError("No call brain configured: set the call_brain setting to a provider preset")
    ctx = {"sid": sid, "principal": principal}
    snap = snapshot_text if snapshot_text is not None else snapshot(sid, principal)
    messages = [{"role": "system", "content": system_prompt(snap)}]
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
                             "content": tool_runner(name, args, ctx)})
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
