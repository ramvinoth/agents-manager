"""Safe audit read contract; no server startup or production database access.

The in-memory SQL adapter executes audit_list's portable SELECT (only parameter
markers differ). Authentication tests call the real HTTP dispatcher and gate.
"""
from contextlib import contextmanager
import json
import sqlite3
from types import SimpleNamespace
from urllib.parse import urlparse

import pytest

from viewer import actions, audit, db, server
from viewer.routes.orchestrator import OrchestratorMixin


SECRET = "SENSITIVE_COMMENT_PASSWORD_PROMPT_SENTINEL"


def row(rid=1, **changes):
    return {"id": rid, "actor": "user:ram", "action": "card_comment",
            "target": {"action": "card_comment", "actor": SECRET,
                       "args": {"card_id": 44, "body": SECRET}},
            "outcome": "done", "created_at": 1789800000.0, **changes}


@pytest.fixture(autouse=True)
def no_database(monkeypatch):
    @contextmanager
    def forbidden():
        raise AssertionError("test attempted to reach the real database")
        yield
    monkeypatch.setattr(db, "_db", forbidden)


def test_exact_display_contract_and_sensitive_exclusion():
    projected = audit.project_entry(row())
    assert projected == {
        "id": 1, "actor": "user:ram", "action": "Comment on card",
        "target": {"label": "Card #44", "card_id": 44},
        "result": {"category": "returned", "label": "Ran",
                   "explanation": audit.project_entry(row())["result"]["explanation"]},
        "created_at": 1789800000.0,
    }
    assert "does not prove" in projected["result"]["explanation"]
    assert SECRET not in json.dumps(projected)


@pytest.mark.parametrize("value", [None, [], {}, True, 0, SECRET])
def test_malformed_targets_are_never_stringified(value):
    projected = audit.project_entry(row(target=value))
    assert projected["target"] == {"label": "Target not available"}
    assert SECRET not in json.dumps(projected)


@pytest.mark.parametrize("target", [
    {"args": SECRET}, {"args": [SECRET]},
    {"action": "card_move", "args": {"card_id": 44, "body": SECRET}},
    {"action": "card_comment", "args": {"card_id": {"id": 44, "secret": SECRET}}},
    {"action": "card_comment", "args": {"card_id": [44, SECRET]}},
    {"action": "card_comment", "args": {"id": 44, "body": SECRET}},
])
def test_bad_envelopes_and_wrong_reference_keys_are_not_targets(target):
    assert audit.project_entry(row(target=target))["target"] == {
        "label": "Target not available"}


@pytest.mark.parametrize("value", [True, False, 0, -1, 4.4, 44.0, "44", "+44",
                                        "44 " + SECRET, 2**53, None])
def test_only_positive_safe_integer_target_ids(value):
    target = {"action": "card_comment", "args": {"card_id": value}}
    assert "card_id" not in audit.project_entry(row(target=target))["target"]


@pytest.mark.parametrize("action,field,label", [
    ("card_move", "card_id", "Card #9"),
    ("card_update", "card_id", "Card #9"),
    ("card_assign", "card_id", "Card #9"),
    ("card_delete", "card_id", "Card #9"),
    ("task_done", "card_id", "Card #9"),
    ("card_dep_add", "card_id", "Card #9"),
    ("card_dep_remove", "card_id", "Card #9"),
    ("employee_update", "id", "Employee #9"),
    ("column_update", "id", "Column #9"),
    ("column_delete", "id", "Column #9"),
    ("approval_resolve", "id", "Approval #9"),
    ("card_create", "project_id", "Project #9"),
    ("column_create", "project_id", "Project #9"),
])
def test_intent_reference_allowlist(action, field, label):
    entry = row(action=action, target={"action": action,
                                      "args": {field: 9, "body": SECRET}})
    target = audit.project_entry(entry)["target"]
    assert target["label"] == label
    assert ("card_id" in target) == label.startswith("Card #")
    assert SECRET not in json.dumps(audit.project_entry(entry))


@pytest.mark.parametrize("action,field,label", [
    ("card_assign", "card", "Card #9"),
    ("card_advance", "card", "Card #9"),
    ("spawn_session", "card", "Card #9"),
    ("board_wake", "card", "Card #9"),
    ("escalate", "approval", "Approval #9"),
    ("approval_resolve", "id", "Approval #9"),
])
def test_direct_writer_reference_allowlist(action, field, label):
    entry = row(action=action, target={field: 9, "error": SECRET})
    assert audit.project_entry(entry)["target"]["label"] == label
    assert SECRET not in json.dumps(audit.project_entry(entry))


@pytest.mark.parametrize("column_id,expected", [
    (40, {"label": "Card #44", "card_id": 44, "column_id": 40}),
    ("40", {"label": "Card #44", "card_id": 44}),
    (0, {"label": "Card #44", "card_id": 44}),
    (None, {"label": "Card #44", "card_id": 44}),
])
def test_move_carries_only_a_validated_destination(column_id, expected):
    target = {"action": "card_move", "args": {"card_id": 44, "column_id": column_id, "body": SECRET}}
    assert audit.project_entry(row(action="card_move", target=target))["target"] == expected


def test_other_actions_never_carry_a_column():
    target = {"action": "card_update", "args": {"card_id": 44, "column_id": 40}}
    assert audit.project_entry(row(action="card_update", target=target))["target"] == {
        "label": "Card #44", "card_id": 44}


def test_name_references_attaches_current_names_and_skips_missing_rows():
    entries = [audit.project_entry(row(1)),
               audit.project_entry(row(2, action="card_move", target={
                   "action": "card_move", "args": {"card_id": 45, "column_id": 40}})),
               audit.project_entry(row(3, target={"action": "card_comment", "args": {"card_id": 46}})),
               audit.project_entry(row(4, target=None))]
    asked = {}
    def titles(ids):
        asked["cards"] = ids
        return {44: "Ship the editor", 46: SECRET, 99: "never asked"}
    def names(ids):
        asked["columns"] = ids
        return {40: "Review"}
    audit.name_references(entries, titles, names)
    assert asked == {"cards": [44, 45, 46], "columns": [40]}
    assert entries[0]["target"] == {"label": "Card #44", "card_id": 44, "title": "Ship the editor"}
    assert entries[1]["target"] == {"label": "Card #45", "card_id": 45, "column_id": 40, "column": "Review"}
    assert entries[2]["target"]["title"] == SECRET  # a title is the card's own public text
    assert entries[3]["target"] == {"label": "Target not available"}


def test_name_references_makes_no_lookup_without_references():
    entries = [audit.project_entry(row(target=None))]
    boom = lambda ids: (_ for _ in ()).throw(AssertionError("looked up nothing"))
    assert audit.name_references(entries, boom, boom) == entries


@pytest.mark.parametrize("action", [SECRET, None, [], {}, "future_action"])
def test_unknown_actions_never_use_arbitrary_labels_or_ids(action):
    projected = audit.project_entry(row(action=action, target={"card_id": 44, "id": 45}))
    assert projected["action"] == "Recorded action"
    assert projected["target"] == {"label": "Target not available"}
    assert SECRET not in json.dumps(projected)


@pytest.mark.parametrize("outcome,category,label", [
    ("done", "returned", "Ran"),
    ("queued:red", "queued", "Sent for approval"),
    ("denied:scope", "denied", "Denied"),
    ("denied:self_resolve", "denied", "Denied"),
    ("denied:self_mutation", "denied", "Denied"),
    ("error:unknown_action", "error", "Failed"),
    ("error", "error", "Failed"),
    ("ok", "other", "Tick ran"),
    ("planned", "other", "Planned (dry run)"),
    ("pending", "other", "Approval opened"),
    ("no_provider", "other", "No session started"),
    ("asked", "other", "Question asked"),
    ("queued", "other", "Wake scheduled"),
    ("denied:" + SECRET, "other", "Unknown result"),
    ("error:" + SECRET, "other", "Unknown result"),
    (SECRET, "other", "Unknown result"),
    (None, "other", "Unknown result"),
    ({"error": SECRET}, "other", "Unknown result"),
])
def test_source_backed_result_mapping(outcome, category, label):
    result = audit.project_entry(row(outcome=outcome))["result"]
    assert result["category"] == category
    assert result["label"] == label
    assert result["explanation"]
    assert SECRET not in json.dumps(result)


def test_handler_error_payload_is_still_recorded_as_returned(monkeypatch):
    captured = []
    monkeypatch.setattr(actions.db, "audit_append", lambda *args: captured.append(args))
    monkeypatch.setitem(actions.ACTIONS, "card_update", lambda _: {"error": SECRET})
    payload, status = actions.execute(actions.intent("card_update", {"card_id": 44}, "user:ram"),
                                      "owner", "")
    assert status == 200 and payload == {"error": SECRET}
    actor, action, target, outcome = captured[0]
    result = audit.project_entry(row(actor=actor, action=action, target=target, outcome=outcome))
    assert result["result"]["label"] == "Ran"
    assert SECRET not in json.dumps(result)


@pytest.mark.parametrize("actor", [None, {}, [SECRET], 4, True, "", "\x00‮\n"])
def test_missing_or_malformed_actor(actor):
    assert audit.project_entry(row(actor=actor))["actor"] == "Unknown actor"


def test_actor_is_bounded_without_controls_or_bidi_overrides():
    actor = audit.project_entry(row(actor=" employee:Zoë\n\t\x00‮ " + "x" * 300))["actor"]
    assert actor.startswith("employee:Zoë ")
    assert len(actor) <= 120
    assert not any(c in actor for c in "\n\t\x00‮")


@pytest.mark.parametrize("timestamp", [None, SECRET, {}, [], True, float("nan"),
                                             float("inf"), -1, 10**1000])
def test_malformed_timestamp_is_json_safe_null(timestamp):
    projected = audit.project_entry(row(created_at=timestamp))
    assert projected["created_at"] is None
    json.dumps(projected, allow_nan=False)


class Handler:
    def send_json(self, body, status=200):
        self.body, self.status = body, status


def get(query="view=display-v1", handler=None):
    handler = handler or Handler()
    OrchestratorMixin._g_org_audit(handler, server._Req(urlparse("/api/org/audit?" + query)))
    return handler.status, handler.body


@pytest.fixture
def sql_store(monkeypatch):
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE audit_log (id INTEGER PRIMARY KEY, actor TEXT, action TEXT, "
                 "target TEXT, outcome TEXT, created_at REAL)")
    statements = []

    class Cursor:
        def execute(self, sql, params):
            statements.append((sql, params))
            self.cursor = conn.execute(sql.replace("%s", "?"), params)

        def fetchall(self):
            return [{**dict(r), "target": json.loads(r["target"])} for r in self.cursor.fetchall()]

    @contextmanager
    def database():
        yield Cursor()

    def insert(entry):
        conn.execute("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)",
                     [entry[k] if k != "target" else json.dumps(entry[k])
                      for k in ("id", "actor", "action", "target", "outcome", "created_at")])

    monkeypatch.setattr(db, "_db", database)
    monkeypatch.setattr(db, "card_titles", lambda ids: {})
    monkeypatch.setattr(db, "board_column_names", lambda ids: {})
    yield SimpleNamespace(insert=insert, statements=statements)
    conn.close()


def test_filter_before_pagination_stable_ids_equal_times_and_insertions(sql_store):
    for rid in range(1, 10):
        sql_store.insert(row(rid, outcome="done" if rid % 2 else "error"))
    status, page = get("view=display-v1&limit=2&result=returned")
    assert status == 200 and page["view"] == "display-v1"
    assert [e["id"] for e in page["audit"]] == [9, 7]
    assert page["next_before"] == 7
    assert sql_store.statements[-1][1][-1] == 3  # lookahead, not another count query
    sql_store.insert(row(10))  # newer entry between page requests must not shift the cursor
    _, page = get("view=display-v1&limit=2&result=returned&before=7")
    assert [e["id"] for e in page["audit"]] == [5, 3]
    assert page["next_before"] == 3
    _, page = get("view=display-v1&limit=2&result=returned&before=3")
    assert [e["id"] for e in page["audit"]] == [1]
    assert page["next_before"] is None
    assert SECRET not in json.dumps(page)


def test_exact_page_end_and_empty_page(sql_store):
    for rid in (1, 2):
        sql_store.insert(row(rid))
    _, page = get("view=display-v1&limit=2")
    assert page["next_before"] is None
    _, page = get("view=display-v1&limit=2&before=1")
    assert page == {"view": "display-v1", "audit": [], "next_before": None}


@pytest.mark.parametrize("category", ["all", "returned", "queued", "denied", "error", "other"])
def test_sql_filter_and_projection_cannot_disagree(sql_store, category):
    outcomes = ["done", "queued:red", "denied:scope", "denied:self_resolve",
                "denied:self_mutation", "error:unknown_action", "error", "ok", "pending",
                "planned", "queued", "asked", "no_provider", "", "error:" + SECRET, None]
    entries = [row(rid, outcome=value) for rid, value in enumerate(outcomes, 1)]
    for entry in entries:
        sql_store.insert(entry)
    expected = [r["id"] for r in reversed(entries)
                if category == "all" or audit.project_entry(r)["result"]["category"] == category]
    _, page = get("view=display-v1&limit=100&result=" + category)
    assert [r["id"] for r in page["audit"]] == expected
    assert page["next_before"] is None


def test_legacy_response_and_reader_filters_unchanged(sql_store):
    a = row(1)
    sql_store.insert(a)
    sql_store.insert(row(2, actor="employee:other", action="task_done"))
    assert db.audit_list(actor="user:ram", action="card_comment") == [a]
    status, legacy = get("limit=1")
    assert status == 200
    assert set(legacy) == {"audit"}
    assert legacy["audit"][0]["id"] == 2
    assert "target" in legacy["audit"][0] and "outcome" in legacy["audit"][0]
    assert SECRET in json.dumps(legacy)  # compatibility, NOT an exposure remediation


@pytest.mark.parametrize("query", [
    "view=unknown", "view=", "view=display-v1&view=display-v1",
    "view=display-v1&limit=0", "view=display-v1&limit=-1",
    "view=display-v1&limit=101", "view=display-v1&limit=1.5",
    "view=display-v1&limit=nan", "view=display-v1&limit=",
    "view=display-v1&limit=1&limit=2", "view=display-v1&limit=+2",
    "view=display-v1&before=0", "view=display-v1&before=-1",
    "view=display-v1&before=1.5", "view=display-v1&before=",
    "view=display-v1&before=9007199254740992", "view=display-v1&before=" + "9" * 5000,
    "view=display-v1&before=1&before=2", "view=display-v1&result=",
    "view=display-v1&result=" + SECRET, "view=display-v1&result=all&result=other",
])
def test_invalid_safe_queries_are_400_without_database_reads(query):
    status, body = get(query)
    assert status == 400
    assert set(body) == {"error"}
    assert SECRET not in json.dumps(body)


def test_safe_defaults(monkeypatch):
    calls = []
    monkeypatch.setattr(db, "audit_list", lambda **kw: calls.append(kw) or [])
    assert get() == (200, {"view": "display-v1", "audit": [], "next_before": None})
    assert calls == [{"limit": 51, "before_id": None, "result": "all"}]


class DispatchHandler(Handler):
    GET_ROUTES = server.SessionViewerHandler.GET_ROUTES
    PUBLIC_API = server.SessionViewerHandler.PUBLIC_API
    _gated = server.SessionViewerHandler._gated
    _resolve_principal = server.SessionViewerHandler._resolve_principal
    _g_org_audit = OrchestratorMixin._g_org_audit

    def __init__(self, user=None, token=""):
        self.path = "/api/org/audit?view=display-v1"
        self.user, self.token = user, token

    def current_user(self):
        return self.user

    def _mcp_credential(self):
        return "test-session", self.token

    def send_error(self, status, message):
        self.status, self.body = status, {"error": message}


@pytest.mark.parametrize("token", ["", "expired-or-forged"])
def test_existing_dispatch_rejects_unauthenticated_reads(monkeypatch, token):
    monkeypatch.setattr(server, "validate_session_credential", lambda *args: None)
    handler = DispatchHandler(token=token)
    server.SessionViewerHandler.do_GET(handler)
    assert handler.status == 401  # no db call; both raw + display route share this gate
    handler.path = "/api/org/audit"
    server.SessionViewerHandler.do_GET(handler)
    assert handler.status == 401


@pytest.mark.parametrize("role", ["viewer", "owner"])
def test_existing_authenticated_human_roles_can_read(sql_store, role):
    sql_store.insert(row())
    handler = DispatchHandler(user={"username": "test", "role": role})
    server.SessionViewerHandler.do_GET(handler)
    assert handler.status == 200
    assert handler.body["view"] == "display-v1"
    assert SECRET not in json.dumps(handler.body)


def test_authenticated_agent_can_read_same_safe_contract(sql_store, monkeypatch):
    sql_store.insert(row())
    monkeypatch.setattr(server, "validate_session_credential",
                        lambda *args: {"level": "ic", "label": "Test"})
    monkeypatch.setattr(db, "owner_role", lambda: "owner")
    handler = DispatchHandler(token="valid-fixture-token")
    server.SessionViewerHandler.do_GET(handler)
    assert handler.status == 200
    assert SECRET not in json.dumps(handler.body)
