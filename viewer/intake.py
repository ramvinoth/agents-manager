"""viewer.intake — inbound doors from the outside world onto a board.

An intake channel is a URL + secret token bound to ONE project board and
(optionally) ONE session. Anything that can POST — a website contact form, a
CI failure, a monitoring alert, a customer-support tool — becomes a card on
that board. The card is created through actions.execute like any other, so
the existing board pipeline does the rest: actions._board_followup wakes the
bound session (boardwatch, coalesced, deferred while busy) and the 30-minute
board_wake sweep re-wakes it until the session answers. No new wake path.

The owner's own in-app feedback is just one client: the channel flagged
`app_feedback` also receives every feedback note the web/phone clients post
(routes.usage). That is how Manager's developers route "this screen is bad"
to the session building Manager — and how any other org routes it anywhere.

Trust: a channel's text comes from OUTSIDE the org. The wake tells the
session so (actions._board_followup), and the card body says where it came
from — content to evaluate, never instructions to follow.

Token, payload → card and view are pure; deliver() is the one function that
touches the db (through actions.execute). db.py holds the SQL and
routes/intake.py the HTTP.
"""
import hashlib
import hmac
import json
import secrets

# Cards one channel may create per hour. A leaked token or a looping sender
# must not bury the board or burn the session's budget on wakes.
RATE_PER_HOUR = 30
TITLE_MAX = 120
BODY_MAX = 8000
EXTERNAL_PREFIX = "intake:"      # actor/created_by of a card that came through a door


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
            if k not in ("title", "text", "body", "message", "url", "from", "token")}
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


def view(channel):
    """A channel as clients may see it: never the token hash. `path` is the
    door; the client prefixes the origin it reached this server on."""
    c = {k: v for k, v in (channel or {}).items() if k != "token_hash"}
    c["path"] = f"/api/intake/{c.get('id', '')}"
    return c


def deliver(channel, payload, origin, human_role="", session_level="ic", actor=""):
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
    ledger and tells the board where the card came in."""
    from viewer import actions, db
    if db.intake_touch(channel["id"]) > RATE_PER_HOUR:
        return {"error": f"rate limit: {RATE_PER_HOUR} cards per hour"}, 429
    title, body = card_fields(channel["name"], payload, origin)
    actor = actor or EXTERNAL_PREFIX + channel["id"]
    args = {"title": title, "body": body, "project_id": channel["project_id"],
            "session": channel.get("session_id") or None,
            "created_by": EXTERNAL_PREFIX + channel["id"]}
    return actions.execute(actions.intent("card_create", args, actor),
                           human_role, session_level)
