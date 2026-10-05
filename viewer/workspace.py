"""viewer.workspace — what agents can do with a connected Google account
beyond files: search/read mail, write drafts, read and edit calendar events.

Each client is an OAuthAccount (viewer.drives) — the same token lifecycle,
refresh and 401-retry as the file adapters — speaking one REST dialect and
returning small, model-friendly dicts (an agent reads these as tool output, so
bodies are plain text, capped, and headers are the handful a human would look
at). Which connection to use and whether the owner turned the service on is
decided by viewer.integrations; this module only talks to the vendor.

Deliberately absent: sending mail, and telling guests about event changes. A
draft lands in the owner's Gmail Drafts and the owner presses Send; an event
edit always goes with sendUpdates=none — an agent never speaks for the owner
to the outside world without a human in the loop. Whether an agent may edit
events at all is the owner's per-account choice (integrations ops).

API facts (VERIFIED 2026-10-05, developers.google.com/workspace/gmail/api/
reference/rest/v1/users.messages{,/list,/get}, users.drafts/create,
/calendar/api/v3/reference/events/list):
  - messages.list returns only {id, threadId} per hit; maxResults ≤ 500;
    `q` is Gmail search syntax.
  - messages.get format=metadata&metadataHeaders=… returns headers + snippet;
    format=full returns the MIME tree with base64url part bodies.
  - drafts.create: POST users/me/drafts {"message": {"raw": base64url
    RFC 2822, "threadId"?}}; gmail.compose suffices.
  - events.list: singleEvents=true expands recurrences; orderBy=startTime
    needs singleEvents; timeMin/timeMax are RFC 3339 with an offset.
  - events.insert/patch/delete (/calendars/{id}/events[/{eventId}]): patch
    leaves unspecified fields unchanged and overwrites arrays; delete answers
    an empty body; all take sendUpdates=all|externalOnly|none.
"""
import base64
import datetime
import email.message
import email.utils
import html
import json
import re
import urllib.parse

from viewer.drives import DriveError, OAuthAccount

_GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me"
_CAL = "https://www.googleapis.com/calendar/v3"
_BODY_CAP = 20000        # characters of a mail body an agent gets back
_HEADERS = ("From", "To", "Cc", "Subject", "Date")


class _GoogleAPI(OAuthAccount):
    kind = "google"

    def _json(self, method, url, body=None):
        data = json.dumps(body).encode() if body is not None else None
        status, raw = self._req(method, url, data=data,
                                headers={"Content-Type": "application/json"} if data else None)
        if 200 <= status < 300:
            return json.loads(raw) if raw else {}
        try:
            msg = (json.loads(raw).get("error") or {}).get("message") or ""
        except Exception:
            msg = ""
        if status == 403 and "has not been used" in msg:
            msg = ("This Google API is turned off in the Google Cloud project that owns Harman's "
                   "OAuth client. Enable it at console.cloud.google.com → APIs & Services → Library.")
        raise DriveError(msg or "Google answered HTTP %d" % status,
                         status if status in (400, 403, 404) else 502)


def _header(headers, name):
    return next((h.get("value", "") for h in headers or [] if h.get("name", "").lower() == name.lower()), "")


def _b64(data):
    return base64.urlsafe_b64decode((data or "") + "=" * (-len(data or "") % 4)).decode("utf-8", "replace")


def _strip_html(s):
    s = re.sub(r"(?is)<(script|style).*?</\1>", "", s)
    s = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</tr>", "\n", s)
    return html.unescape(re.sub(r"<[^>]+>", "", s))


def body_text(payload):
    """The readable text of a Gmail MIME tree: the first text/plain part, else
    the first text/html part stripped to text. Pure."""
    plain, rich = [], []

    def walk(part):
        mt = part.get("mimeType", "")
        data = (part.get("body") or {}).get("data")
        if data and not part.get("filename"):
            (plain if mt == "text/plain" else rich if mt == "text/html" else []).append(_b64(data))
        for p in part.get("parts") or []:
            walk(p)

    walk(payload or {})
    text = plain[0] if plain else _strip_html(rich[0]) if rich else ""
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return text[:_BODY_CAP] + ("\n…[truncated]" if len(text) > _BODY_CAP else "")


def build_raw(to, subject, body, cc="", in_reply_to="", references=""):
    """An RFC 2822 message, base64url-encoded as drafts.create expects. Pure."""
    m = email.message.EmailMessage()
    m["To"] = to
    if cc:
        m["Cc"] = cc
    m["Subject"] = subject
    if in_reply_to:
        m["In-Reply-To"] = in_reply_to
        m["References"] = references or in_reply_to
    m.set_content(body)
    return base64.urlsafe_b64encode(m.as_bytes()).decode("ascii")


class Gmail(_GoogleAPI):
    def search(self, q="", limit=20):
        limit = max(1, min(int(limit or 20), 50))
        j = self._json("GET", _GMAIL + "/messages?" + urllib.parse.urlencode(
            {"q": q or "in:inbox", "maxResults": limit}))
        out = []
        for m in j.get("messages") or []:
            meta = self._json("GET", _GMAIL + "/messages/%s?format=metadata&%s" % (
                urllib.parse.quote(m["id"]),
                "&".join("metadataHeaders=" + h for h in _HEADERS)))
            hs = (meta.get("payload") or {}).get("headers")
            out.append({"id": m["id"], "thread": m.get("threadId", ""),
                        "from": _header(hs, "From"), "subject": _header(hs, "Subject"),
                        "date": _header(hs, "Date"), "snippet": html.unescape(meta.get("snippet", "")),
                        "unread": "UNREAD" in (meta.get("labelIds") or [])})
        return {"messages": out, "estimate": j.get("resultSizeEstimate", len(out))}

    def read(self, mid):
        if not mid:
            raise DriveError("id is required", 400)
        m = self._json("GET", _GMAIL + "/messages/%s?format=full" % urllib.parse.quote(mid))
        p = m.get("payload") or {}
        hs = p.get("headers")
        attachments = []

        def walk(part):
            if part.get("filename"):
                attachments.append(part["filename"])
            for c in part.get("parts") or []:
                walk(c)

        walk(p)
        return {"id": m.get("id", mid), "thread": m.get("threadId", ""),
                **{h.lower(): _header(hs, h) for h in _HEADERS},
                "message_id": _header(hs, "Message-ID"),
                "labels": m.get("labelIds") or [], "attachments": attachments,
                "body": body_text(p)}

    def draft(self, to, subject, body, cc="", reply_to=""):
        """A draft in the owner's Gmail. `reply_to` is a message id: the draft
        joins that thread with the RFC 2822 reply headers Gmail requires."""
        if not to or not subject or not body:
            raise DriveError("to, subject and body are required", 400)
        msg = {}
        irt = refs = ""
        if reply_to:
            orig = self._json("GET", _GMAIL + "/messages/%s?format=metadata&metadataHeaders=Message-ID"
                                              "&metadataHeaders=References" % urllib.parse.quote(reply_to))
            hs = (orig.get("payload") or {}).get("headers")
            irt = _header(hs, "Message-ID")
            refs = (_header(hs, "References") + " " + irt).strip()
            msg["threadId"] = orig.get("threadId", "")
        msg["raw"] = build_raw(to, subject, body, cc, irt, refs)
        d = self._json("POST", _GMAIL + "/drafts", {"message": msg})
        return {"draft": d.get("id", ""), "thread": (d.get("message") or {}).get("threadId", ""),
                "note": "Saved in Gmail Drafts — the owner reviews and sends it."}


def _rfc3339(value, default):
    """An ISO date/datetime → RFC 3339 with an offset (naive → UTC). Pure."""
    if not value:
        return default.isoformat()
    try:
        d = datetime.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        raise DriveError("Dates must be ISO 8601, e.g. 2026-10-05 or 2026-10-05T09:00:00-07:00", 400)
    return (d if d.tzinfo else d.replace(tzinfo=datetime.timezone.utc)).isoformat()


def event_time(value, all_day):
    """A start/end in the Calendar API's shape: {"date"} for an all-day event,
    else {"dateTime"} with an offset. Pure."""
    if not value:
        raise DriveError("start and end are required", 400)
    if all_day:
        try:
            return {"date": datetime.date.fromisoformat(str(value)[:10]).isoformat()}
        except ValueError:
            raise DriveError("An all-day date must look like 2026-10-05", 400)
    return {"dateTime": _rfc3339(value, None)}


def event_body(fields):
    """The Calendar API body for the fields an editor sent — only those it
    sent, since a patch keeps every field it does not name. Pure."""
    b = {}
    if "title" in fields:
        b["summary"] = fields["title"] or ""
    for k in ("location", "description"):
        if k in fields:
            b[k] = fields[k] or ""
    all_day = bool(fields.get("all_day"))
    for k in ("start", "end"):
        if k in fields:
            b[k] = event_time(fields[k], all_day)
    if "attendees" in fields:
        b["attendees"] = [{"email": a} for a in fields["attendees"] or [] if a]
    return b


def _event(e):
    s, f = e.get("start") or {}, e.get("end") or {}
    return {"id": e.get("id", ""), "title": e.get("summary", "(no title)"),
            "start": s.get("dateTime") or s.get("date", ""),
            "end": f.get("dateTime") or f.get("date", ""),
            "all_day": "date" in s, "location": e.get("location", ""),
            "description": e.get("description", ""),
            "attendees": [a.get("email", "") for a in e.get("attendees") or []][:20],
            "link": e.get("htmlLink", ""), "status": e.get("status", "")}


class Calendar(_GoogleAPI):
    def _url(self, calendar, event=""):
        u = "%s/calendars/%s/events" % (_CAL, urllib.parse.quote(calendar or "primary", safe=""))
        return u + ("/" + urllib.parse.quote(event, safe="") if event else "")

    def create(self, fields, calendar="primary"):
        body = event_body(fields)
        if "start" not in body or "end" not in body:
            raise DriveError("start and end are required", 400)
        body.setdefault("summary", "(no title)")
        return _event(self._json("POST", self._url(calendar) + "?sendUpdates=none", body))

    def update(self, event, fields, calendar="primary"):
        if not event:
            raise DriveError("id is required", 400)
        body = event_body(fields)
        if not body:
            raise DriveError("Nothing to change", 400)
        return _event(self._json("PATCH", self._url(calendar, event) + "?sendUpdates=none", body))

    def delete(self, event, calendar="primary"):
        if not event:
            raise DriveError("id is required", 400)
        self._json("DELETE", self._url(calendar, event) + "?sendUpdates=none")
        return {"deleted": event}

    def events(self, start="", end="", q="", calendar="primary", limit=50):
        now = datetime.datetime.now(datetime.timezone.utc)
        t0 = _rfc3339(start, now)
        t1 = _rfc3339(end, now + datetime.timedelta(days=7))
        params = {"timeMin": t0, "timeMax": t1, "singleEvents": "true", "orderBy": "startTime",
                  "maxResults": max(1, min(int(limit or 50), 250))}
        if q:
            params["q"] = q
        j = self._json("GET", self._url(calendar) + "?" + urllib.parse.urlencode(params))
        out = [_event(e) for e in j.get("items") or []]
        return {"calendar": j.get("summary", calendar), "time_zone": j.get("timeZone", ""),
                "from": t0, "to": t1, "events": out}
