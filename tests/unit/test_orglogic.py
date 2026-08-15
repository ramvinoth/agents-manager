"""Unit tests for viewer.orglogic — the pure org/Kanban logic (no db/server).

Covers the "one canonical board → filtered views" rules (filter_cards, order_column,
next_position fractional indexing), Harman's Green/Red approval gate (classify_action),
and the learned-skill dedup (dedupe_skill). Hermetic; runs under `make unit`.
"""
from viewer import orglogic


# ── filter_cards ──────────────────────────────────────────────────────────────

CARDS = [
    {"id": 1, "session_id": "s1", "project_id": 10, "assignee": 100, "position": 2.0},
    {"id": 2, "session_id": "s1", "project_id": 10, "assignee": 200, "position": 1.0},
    {"id": 3, "session_id": "s2", "project_id": 20, "assignee": 100, "position": 3.0},
    {"id": 4, "session_id": "s2", "project_id": 10, "assignee": 200, "position": 1.5},
]


def _ids(cards):
    return [c["id"] for c in cards]


def test_filter_none_returns_all():
    assert _ids(orglogic.filter_cards(CARDS)) == [1, 2, 3, 4]


def test_filter_by_session():
    assert _ids(orglogic.filter_cards(CARDS, session="s1")) == [1, 2]


def test_filter_by_project():
    assert _ids(orglogic.filter_cards(CARDS, project=10)) == [1, 2, 4]


def test_filter_by_assignee():
    assert _ids(orglogic.filter_cards(CARDS, assignee=100)) == [1, 3]


def test_filter_combined_and_semantics():
    # session s2 AND project 10 → only card 4
    assert _ids(orglogic.filter_cards(CARDS, session="s2", project=10)) == [4]


def test_filter_no_match():
    assert orglogic.filter_cards(CARDS, assignee=999) == []


# ── order_column ────────────────────────────────────────────────────────────

def test_order_by_position():
    col = [{"id": 1, "position": 3.0}, {"id": 2, "position": 1.0}, {"id": 3, "position": 2.0}]
    assert _ids(orglogic.order_column(col)) == [2, 3, 1]


def test_order_missing_position_treated_zero_and_stable():
    col = [{"id": 1}, {"id": 2, "position": -1.0}, {"id": 3}]
    # card 2 (-1) first; 1 and 3 both 0.0 keep input order
    assert _ids(orglogic.order_column(col)) == [2, 1, 3]


# ── next_position (fractional indexing) ──────────────────────────────────────

def test_next_position_empty_column():
    assert orglogic.next_position([], 0) == 1.0


def test_next_position_top():
    col = [{"id": 1, "position": 5.0}, {"id": 2, "position": 6.0}]
    assert orglogic.next_position(col, 0) == 4.0  # below the first


def test_next_position_bottom():
    col = [{"id": 1, "position": 5.0}, {"id": 2, "position": 6.0}]
    assert orglogic.next_position(col, 2) == 7.0  # above the last


def test_next_position_middle_is_midpoint():
    col = [{"id": 1, "position": 4.0}, {"id": 2, "position": 6.0}]
    assert orglogic.next_position(col, 1) == 5.0


def test_next_position_orders_input_first():
    # unordered input; inserting between the two lowest
    col = [{"id": 1, "position": 6.0}, {"id": 2, "position": 4.0}]
    assert orglogic.next_position(col, 1) == 5.0


# ── classify_action (Green/Red gate) ─────────────────────────────────────────

def test_classify_red_by_action_name():
    for a in ("delete_session", "reveal_secret", "reboot_host", "testflight_submit"):
        assert orglogic.classify_action(a) == "red", a


def test_classify_green_default_for_unknown():
    for a in ("create_card", "move_card", "assign_employee", "read_transcript", ""):
        assert orglogic.classify_action(a) == "green", a


def test_classify_by_kind_dict():
    assert orglogic.classify_action({"kind": "money"}) == "red"
    assert orglogic.classify_action({"kind": "infra"}) == "red"
    assert orglogic.classify_action({"kind": "note"}) == "green"


def test_classify_dict_falls_back_to_action_name():
    assert orglogic.classify_action({"action": "delete_project"}) == "red"
    assert orglogic.classify_action({"action": "create_card"}) == "green"


def test_is_red_helper():
    assert orglogic.is_red("git_force_push") is True
    assert orglogic.is_red("move_card") is False


# ── dedupe_skill ─────────────────────────────────────────────────────────────

def test_dedupe_exact_after_normalization():
    assert orglogic.dedupe_skill("Ship to TestFlight", ["ship-to-testflight"]) is True


def test_dedupe_phrase_containment():
    assert orglogic.dedupe_skill("deploy", ["deploy the ios app"]) is True
    assert orglogic.dedupe_skill("build and deploy ios", ["deploy"]) is True


def test_dedupe_partial_word_does_not_collide():
    # "deploy" must NOT match "deployment" (whole-token boundaries)
    assert orglogic.dedupe_skill("deploy", ["deployment pipeline"]) is False


def test_dedupe_no_match_and_empty():
    assert orglogic.dedupe_skill("write tests", ["ship build", "restart gpu"]) is False
    assert orglogic.dedupe_skill("", ["anything"]) is False
    assert orglogic.dedupe_skill("x", []) is False
