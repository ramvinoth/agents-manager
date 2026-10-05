"""Tests for viewer.workspace — Gmail/Calendar clients over the shared _http
seam (no network). A fake Google answers the exact URLs the clients build."""
import base64
import email
import json
import time
import urllib.parse

import pytest

from viewer import drives, workspace
from viewer.drives import DriveError


def _b64(s):
    return base64.urlsafe_b64encode(s.encode()).decode().rstrip("=")


class _FakeGoogle:
    def __init__(self):
        self.calls = []
        self.drafts = []

    def __call__(self, method, url, headers=None, data=None, timeout=60):
        self.calls.append((method, url))
        u = urllib.parse.urlparse(url)
        q = urllib.parse.parse_qs(u.query)
        if u.path.endswith("/messages"):
            return 200, {}, json.dumps({"messages": [{"id": "m1", "threadId": "t1"}],
                                        "resultSizeEstimate": 1}).encode()
        if u.path.endswith("/messages/m1") and q.get("format") == ["metadata"]:
            return 200, {}, json.dumps({"id": "m1", "threadId": "t1", "labelIds": ["UNREAD"],
                                        "snippet": "Hi &amp; bye", "payload": {"headers": [
                                            {"name": "From", "value": "a@x"}, {"name": "Subject", "value": "S"},
                                            {"name": "Message-ID", "value": "<orig@x>"}]}}).encode()
        if u.path.endswith("/messages/m1"):
            return 200, {}, json.dumps({"id": "m1", "threadId": "t1", "payload": {
                "mimeType": "multipart/mixed", "headers": [{"name": "Subject", "value": "S"}], "parts": [
                    {"mimeType": "multipart/alternative", "parts": [
                        {"mimeType": "text/html", "body": {"data": _b64("<p>rich</p>")}},
                        {"mimeType": "text/plain", "body": {"data": _b64("plain body")}}]},
                    {"mimeType": "application/pdf", "filename": "a.pdf", "body": {"attachmentId": "x"}}]}}).encode()
        if u.path.endswith("/drafts"):
            self.drafts.append(json.loads(data))
            return 200, {}, json.dumps({"id": "d1", "message": {"threadId": "t1"}}).encode()
        if "/calendars/primary/events" in u.path:
            assert q["singleEvents"] == ["true"] and q["orderBy"] == ["startTime"]
            return 200, {}, json.dumps({"summary": "ram@x", "timeZone": "America/Los_Angeles", "items": [
                {"id": "e1", "summary": "Standup", "start": {"dateTime": "2026-10-06T09:00:00-07:00"},
                 "end": {"dateTime": "2026-10-06T09:15:00-07:00"}, "attendees": [{"email": "b@x"}]},
                {"id": "e2", "start": {"date": "2026-10-07"}, "end": {"date": "2026-10-08"}}]}).encode()
        if "/apis-off" in u.path:
            return 403, {}, json.dumps({"error": {"message": "Gmail API has not been used in project 1"}}).encode()
        return 404, {}, b"{}"


@pytest.fixture()
def google(monkeypatch):
    fake = _FakeGoogle()
    monkeypatch.setattr(drives, "_http", fake)
    return fake


def _acct(cls):
    return cls({"id": "c1", "kind": "google", "config": {
        "access_token": "AT", "refresh_token": "RT", "token_expiry": time.time() + 3600}})


def test_search_returns_headers_and_unread(google):
    r = _acct(workspace.Gmail).search("from:a", 5)
    assert r["messages"] == [{"id": "m1", "thread": "t1", "from": "a@x", "subject": "S", "date": "",
                              "snippet": "Hi & bye", "unread": True}]
    assert "q=from%3Aa" in google.calls[0][1] and "maxResults=5" in google.calls[0][1]


def test_read_prefers_plain_text_and_lists_attachments(google):
    r = _acct(workspace.Gmail).read("m1")
    assert r["body"] == "plain body" and r["attachments"] == ["a.pdf"] and r["subject"] == "S"


def test_html_only_body_is_stripped():
    p = {"mimeType": "text/html", "body": {"data": _b64("<style>x{}</style><p>Hello&nbsp;<b>you</b></p>")}}
    assert workspace.body_text(p) == "Hello\xa0you"


def test_reply_draft_joins_the_thread_with_reply_headers(google):
    r = _acct(workspace.Gmail).draft("a@x", "Re: S", "thanks", reply_to="m1")
    assert r["draft"] == "d1"
    msg = google.drafts[0]["message"]
    assert msg["threadId"] == "t1"
    m = email.message_from_bytes(base64.urlsafe_b64decode(msg["raw"]))
    assert m["To"] == "a@x" and m["In-Reply-To"] == "<orig@x>" and m.get_payload().strip() == "thanks"
    assert not any("send" in url for _, url in google.calls)


def test_draft_requires_fields(google):
    assert pytest.raises(DriveError, _acct(workspace.Gmail).draft, "", "s", "b").value.status == 400


def test_calendar_events_flatten(google):
    r = _acct(workspace.Calendar).events("2026-10-06", "2026-10-08")
    assert r["from"] == "2026-10-06T00:00:00+00:00"
    assert [e["title"] for e in r["events"]] == ["Standup", "(no title)"]
    assert r["events"][1]["all_day"] is True and r["events"][0]["attendees"] == ["b@x"]
    assert pytest.raises(DriveError, _acct(workspace.Calendar).events, "next tuesday").value.status == 400


def test_disabled_api_explains_the_fix(google):
    with pytest.raises(DriveError) as e:
        _acct(workspace.Gmail)._json("GET", "https://gmail.googleapis.com/apis-off")
    assert e.value.status == 403 and "Enable it" in str(e.value)
