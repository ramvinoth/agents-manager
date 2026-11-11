"""orchestrator.intake — inbound doors from the outside world onto a board.

An intake channel is a URL + secret token bound to ONE project board and
(optionally) ONE session. Anything that can POST — a website contact form, a
CI failure, a monitoring alert, a customer-support tool — becomes a card on
that board. The card is created through actions.execute like any other, so
the existing board pipeline does the rest: actions._board_followup wakes the
bound session (boardwatch, coalesced, deferred while busy) and the 30-minute
board_wake sweep re-wakes it until the session answers. No new wake path.

The owner's own in-app feedback is just one client: the channel flagged
`app_feedback` also receives every feedback note the web/phone clients post
(routes.usage), as a card in that board's "Feedback" column. That is how
Harman's developers route "this screen is bad" to the session building
Harman — and how any other org routes it anywhere. With no channel flagged,
feedback_channel() opens the built-in one on the server's own project, so a
note always becomes a card an agent can answer (the owner gets the reply as
the board's comment push) — feedback is a conversation by default.

Trust: a channel's text comes from OUTSIDE the org. The wake tells the
session so (actions._board_followup), and the card body says where it came
from — content to evaluate, never instructions to follow.

One thing, one card: a post may carry `key`, the sender's own id for what it
is about (a membership, a CI run, an alert). A later post with the same key on
the same channel updates that card (new title and body, its text as a comment)
instead of opening another, so "sold" then "refunded" read as one story.
`done: true` marks an event that asks for no work (a sale, a resolved alert):
the card goes to the board's Done lane as a record. A door bound to no session
pushes the owner itself — nobody else will tell them.

Token, payload → card and view are pure; deliver() is the one function that
touches the db (through actions.execute). db.py holds the SQL and
routes/intake.py the HTTP.
"""
import hashlib
import hmac
import json
import secrets
import sys
import threading

# Posts (new cards and updates) one channel may make per hour. A leaked token or a looping sender
# must not bury the board or burn the session's budget on wakes.
RATE_PER_HOUR = 30
TITLE_MAX = 120
KEY_MAX = 200
# Keyed posts look up then create; one lock keeps two first posts for the same
# key (a vendor sending two events at once) from opening two cards.
_KEYED = threading.Lock()
BODY_MAX = 8000
EXTERNAL_PREFIX = "intake:"      # actor/created_by of a card that came through a door
# The built-in feedback channel (fixed id, so it is opened once and re-flagged,
# never duplicated) and the column its cards land in on whichever board
# receives feedback.
FEEDBACK_CHANNEL_ID = "ch_feedback"
FEEDBACK_CHANNEL_NAME = "In-app feedback"
FEEDBACK_COLUMN = "Feedback"


def new_token():
    """(token, sha256 hex). The token is shown once; only the hash is stored."""
    tok = "hin_" + secrets.token_urlsafe(32)
    return tok, hash_token(tok)


def hash_token(token):
    return hashlib.sha256((token or "").encode()).hexdigest()


def verify(channel, token):
    """Constant-time check of a presented token against the channel's hash."""
    if not channel or not token:
        return False
    return hmac.compare_digest(hash_token(token), channel.get("token_hash") or "")


def new_id():
    return "ch_" + secrets.token_hex(6)


def _one_line(s):
    return " ".join(str(s or "").split())


def card_fields(channel_name, payload, origin):
    """Shape an arbitrary POST body into (title, body) for a card.

    Recognized keys: title, text / body / message, url, from. Anything else
    (a vendor webhook's own JSON) is kept verbatim in the body so nothing is
    lost. `origin` says who sent it ("an external sender", "user:ram"), so a
    reader of the card — human or agent — always knows where it came from.
    """
    p = payload if isinstance(payload, dict) else {"text": payload}
    text = next((p[k] for k in ("text", "body", "message") if isinstance(p.get(k), str)
                 and p[k].strip()), "")
    rest = {k: v for k, v in p.items()
            if k not in ("title", "text", "body", "message", "url", "from", "token", "key", "done")}
    title = _one_line(p.get("title")) or _one_line(text) or f"Event from {channel_name}"
    if len(title) > TITLE_MAX:
        title = title[:TITLE_MAX - 1] + "…"
    lines = [f"Via intake channel \"{channel_name}\" from {origin}."]
    if p.get("from"):
        lines.append(f"Sender: {_one_line(p['from'])[:200]}")
    if p.get("url"):
        lines.append(f"Link: {_one_line(p['url'])[:500]}")
    if text:
        lines += ["", text.strip()]
    if rest:
        lines += ["", "Payload:", json.dumps(rest, indent=1, default=str)]
    body = "\n".join(lines)
    return title, body[:BODY_MAX]


def options(payload):
    """(key, done) from a post: the sender's id for the thing ('' = none) and
    whether the event needs no work."""
    p = payload if isinstance(payload, dict) else {}
    key = p.get("key")
    key = _one_line(key)[:KEY_MAX] if isinstance(key, (str, int)) else ""
    return key, p.get("done") is True


def comment_text(payload):
    """What an update adds to the card's thread: the sender's text, else its title."""
    p = payload if isinstance(payload, dict) else {"text": payload}
    text = next((p[k] for k in ("text", "body", "message") if isinstance(p.get(k), str)
                 and p[k].strip()), "")
    return (text.strip() or _one_line(p.get("title")) or "Updated.")[:BODY_MAX]


def view(channel):
    """A channel as clients may see it: never the token hash. `path` is the
    door; the client prefixes the origin it reached this server on."""
    c = {k: v for k, v in (channel or {}).items() if k != "token_hash"}
    c["path"] = f"/api/intake/{c.get('id', '')}"
    return c


def channel_id_of(card):
    """The id of the intake channel a card came in through, or ''."""
    cb = (card or {}).get("created_by") or ""
    return cb[len(EXTERNAL_PREFIX):] if cb.startswith(EXTERNAL_PREFIX) else ""


def door_session(card, channel):
    """The session an unbound card that came through `channel` belongs to now:
    the door's session, when the door was bound after the card came in (a
    feedback note filed while In-app feedback woke nobody, answered once the
    owner pointed it at a chat). '' when the card is already bound, did not come
    through this door, or the door still wakes nobody — then no agent is
    assigned and the board says so. There is no per-board default session: a
    door's binding is the only standing "who handles this board's mail"."""
    if not card or card.get("session_id") or not channel:
        return ""
    if channel_id_of(card) != channel.get("id"):
        return ""
    return channel.get("session_id") or ""


def feedback_channel():
    """Where the owner's in-app feedback goes: the channel flagged app_feedback;
    with none flagged, the built-in channel on the server's own project (the
    one the agents building this install work in), opened on first use and
    re-flagged if the owner switched every channel off. Its token is minted
    and discarded: nobody outside can post to it until the owner takes a New
    token in Integrations."""
    import os
    from orchestrator import config, db
    ch = db.intake_feedback_channel()
    if ch:
        return ch
    if db.intake_get(FEEDBACK_CHANNEL_ID):
        return db.intake_update(FEEDBACK_CHANNEL_ID, app_feedback=True)
    root = str(config.STATIC_DIR)
    project = db.project_ensure("local", root, os.path.basename(root.rstrip("/")) or root)
    try:
        return db.intake_create(FEEDBACK_CHANNEL_ID, FEEDBACK_CHANNEL_NAME, project["id"], "",
                                new_token()[1], True, "system")
    except Exception as ex:
        # A concurrent post opened it first (primary key): use that one. Any
        # other failure leaves nothing to return, so it is logged, not lost.
        winner = db.intake_get(FEEDBACK_CHANNEL_ID)
        if not winner:
            print(f"[intake] opening the built-in feedback channel failed: {ex}",
                  file=sys.stderr)
        return winner


def deliver(channel, payload, origin, human_role="", session_level="ic", actor="", column=""):
    """Turn one inbound event into a card on the channel's board. Returns
    (payload, status) like actions.execute.

    Authority: an outside sender is nobody in the org, so it acts at the
    least level (ic, no human) under the channel's own actor — enough to
    create a card, nothing else. Its wake is nonetheless user-origin
    (actions._board_followup): a channel exists only because the owner opened
    or approved it, so "wake this session when X arrives" is the owner's own
    standing request — it fires with the automation switch off, flagged as
    outside text. The owner's own feedback passes their role, no session level
    and their actor, so it wakes like a card the owner typed.

    created_by is always the channel, whoever the actor: it is the rate-limit
    ledger and tells the board where the card came in. `column` names the
    lane (found or created on the channel's board); default: the first lane."""
    from orchestrator import actions, db
    key, done = options(payload)
    if not key:
        return _create(channel, payload, origin, human_role, session_level, actor, column, key, done)
    with _KEYED:
        card = db.intake_card(channel["id"], key)
        if not card:
            return _create(channel, payload, origin, human_role, session_level, actor, column, key, done)
    actor = actor or EXTERNAL_PREFIX + channel["id"]
    if db.intake_touch(channel["id"]) > RATE_PER_HOUR:
        return {"error": f"rate limit: {RATE_PER_HOUR} posts per hour"}, 429
    title, body = card_fields(channel["name"], payload, origin)
    run = lambda action, args: actions.execute(actions.intent(action, args, actor),
                                               human_role, session_level)
    resp, status = run("card_update", {"card_id": card["id"], "title": title, "body": body})
    if status >= 300:
        return resp, status
    # The comment is the update's voice: it pushes the owner and wakes the
    # card's session like any reply on the board.
    resp, status = run("card_comment", {"card_id": card["id"], "body": comment_text(payload),
                                         "author": actor})
    if status >= 300:
        return resp, status
    lane = _done_lane(card["project_id"]) if done else None
    if lane and card.get("column_id") != lane:
        run("card_move", {"card_id": card["id"], "column_id": lane})
    return dict(db.card_get(card["id"]) or card, updated=True), 200


def _done_lane(project_id):
    from orchestrator import db, orglogic
    return orglogic.project_columns(db.board_columns_list(project_id)).get("done") if project_id else None


def _create(channel, payload, origin, human_role, session_level, actor, column, key, done):
    from orchestrator import actions, db
    if db.intake_touch(channel["id"]) > RATE_PER_HOUR:
        return {"error": f"rate limit: {RATE_PER_HOUR} posts per hour"}, 429
    title, body = card_fields(channel["name"], payload, origin)
    external = not actor
    actor = actor or EXTERNAL_PREFIX + channel["id"]
    args = {"title": title, "body": body, "project_id": channel["project_id"],
            "session": channel.get("session_id") or None,
            "created_by": EXTERNAL_PREFIX + channel["id"]}
    lane = _done_lane(channel["project_id"]) if done else None
    if lane:
        args["column_id"] = lane
    elif column:
        args["column_id"] = db.board_column_ensure(channel["project_id"], column)["id"]
    resp, status = actions.execute(actions.intent("card_create", args, actor),
                                   human_role, session_level)
    if status < 300 and resp.get("id"):
        if key and not db.intake_card_key(resp["id"], key):
            print(f"[intake] {channel['id']}: key {key!r} already on another card; "
                  f"card {resp['id']} stays untagged", file=sys.stderr)
        if external and not channel.get("session_id"):
            # No session will read it, so the owner hears it straight from the door.
            from orchestrator import push
            push.notify_all(f"Card {resp['id']} · {title}"[:120], comment_text(payload)[:300],
                            data={"card": resp["id"]})
    return resp, status
