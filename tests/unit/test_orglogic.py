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


def test_card_delete_is_red_and_lead_scoped():
    # Deleting a card is destructive → red (queued for an MCP employee), and needs
    # lead+ authority (an IC cannot delete work items).
    assert orglogic.classify_action("card_delete") == "red"
    assert orglogic.allowed("card_delete", "ic") is False
    assert orglogic.allowed("card_delete", "lead") is True
    assert orglogic.allowed("card_delete", "manager") is True


# ── allowed() responsibility scope ───────────────────────────────────────────

def test_allowed_ic_can_manage_cards():
    for a in ("card_create", "card_move", "card_update", "task_done", "board_list", "card_list"):
        assert orglogic.allowed(a, "ic") is True, a


def test_allowed_ic_cannot_create_project_or_hire():
    assert orglogic.allowed("project_create", "ic") is False
    assert orglogic.allowed("employee_create", "ic") is False


def test_allowed_lead_can_project_and_reassign_not_hire():
    assert orglogic.allowed("project_create", "lead") is True
    assert orglogic.allowed("card_assign", "lead") is True
    assert orglogic.allowed("employee_create", "lead") is False


def test_allowed_manager_can_hire():
    assert orglogic.allowed("employee_create", "manager") is True
    assert orglogic.allowed("employee_update", "manager") is True
    # manager also inherits everything below
    assert orglogic.allowed("project_create", "manager") is True
    assert orglogic.allowed("card_create", "manager") is True


def test_allowed_unknown_action_denied():
    assert orglogic.allowed("nuke_everything", "manager") is False


def test_allowed_unknown_level_denied():
    assert orglogic.allowed("card_create", "intern") is False
    assert orglogic.allowed("card_create", "") is False


def test_allowed_accepts_dict():
    assert orglogic.allowed({"action": "project_create"}, "lead") is True
    assert orglogic.allowed({"action": "employee_create"}, "ic") is False


# ── effective_level(): TWO principals, authority is the weaker ───────────────

def test_effective_level_takes_the_weaker():
    # A viewer human cannot be escalated by a manager-level agent session...
    assert orglogic.effective_level("viewer", "manager") == "ic"
    # ...and an owner cannot lift an ic session.
    assert orglogic.effective_level("owner", "ic") == "ic"
    assert orglogic.effective_level("operator", "manager") == "lead"
    assert orglogic.effective_level("owner", "manager") == "manager"


def test_effective_level_missing_principal_does_not_constrain():
    # Human at the UI: no agent session is acting → the role's ceiling.
    assert orglogic.effective_level("owner", "") == "manager"
    assert orglogic.effective_level("viewer", "") == "ic"
    # Unattended spawn with no logged-in human → the session level stands.
    assert orglogic.effective_level("", "lead") == "lead"
    assert orglogic.effective_level(None, "manager") == "manager"


def test_effective_level_no_principal_is_no_authority():
    assert orglogic.effective_level("", "") == ""
    assert orglogic.effective_level(None, None) == ""
    assert orglogic.allowed("card_create", orglogic.effective_level("", "")) is False


def test_effective_level_unknown_values_fall_back_not_down():
    # A typo'd role must not silently strip a valid session's authority...
    assert orglogic.effective_level("supervisor", "lead") == "lead"
    # ...nor a typo'd session level strip a valid role's.
    assert orglogic.effective_level("owner", "principal") == "manager"
    # Both unknown → nothing.
    assert orglogic.effective_level("supervisor", "principal") == ""


def test_effective_level_gates_a_real_action():
    # The whole point: a viewer human driving a manager agent still can't hire.
    lvl = orglogic.effective_level("viewer", "manager")
    assert orglogic.allowed("employee_create", lvl) is False
    assert orglogic.allowed("card_create", lvl) is True


def test_every_human_role_has_a_ceiling():
    # A role with no ceiling entry would resolve to "absent" and silently defer
    # to the session level — an escalation. Keep the two tables in lockstep.
    for role in orglogic.HUMAN_ROLES:
        assert orglogic.effective_level(role, "manager") in orglogic.LEVELS


def test_min_level_values_are_real_levels():
    # A typo'd requirement ("leader") ranks -1 and would grant the action to
    # everyone, including an unknown level. Deny-by-default only holds if the
    # right-hand side of the table is valid.
    for action, required in orglogic._MIN_LEVEL.items():
        assert required in orglogic.LEVELS, action


# ── self_approves(): the owner's own click IS the approval ───────────────────

def test_self_approves_only_owner_acting_directly():
    assert orglogic.self_approves("owner", "") is True
    assert orglogic.self_approves("owner", None) is True


def test_self_approves_denies_agents_and_lesser_humans():
    # An agent NEVER self-approves, even under the owner's ceiling: a model chose
    # the action, and the point of the Red gate is that a human sees it first.
    assert orglogic.self_approves("owner", "manager") is False
    assert orglogic.self_approves("owner", "ic") is False
    # Non-owner humans escalate TO the owner, so there is someone to ask.
    assert orglogic.self_approves("operator", "") is False
    assert orglogic.self_approves("viewer", "") is False
    assert orglogic.self_approves("", "") is False
    assert orglogic.self_approves(None, None) is False


# ── may_resolve(): nobody answers their own escalation ───────────────────────

def test_may_resolve_refuses_the_principal_who_raised_it():
    # The rail that keeps the Red gate from being theatre: escalate, then
    # rubber-stamp yourself.
    ap = {"id": 1, "created_by": "employee:bob"}
    assert orglogic.may_resolve(ap, "employee:bob") is False
    assert orglogic.may_resolve(ap, "user:ram") is True


def test_may_resolve_applies_to_humans_too():
    # An operator can resolve approvals, so without this they could queue a Red
    # action and wave it through alone — the same hole with a person's name on it.
    ap = {"id": 2, "created_by": "user:sam"}
    assert orglogic.may_resolve(ap, "user:sam") is False
    assert orglogic.may_resolve(ap, "user:ram") is True


def test_may_resolve_allows_a_missing_or_anonymous_approval():
    # An approval with no recorded creator cannot implicate anyone; the scope gate
    # still bounds who may call approval_resolve at all.
    assert orglogic.may_resolve(None, "user:ram") is True
    assert orglogic.may_resolve({}, "user:ram") is True


# ── the agent loop-control tier: scope + risk of scheduling recurring work ────

def test_scheduling_loops_needs_lead_authority():
    # Authoring a recurring prompt shapes the board's future work, so it sits at the
    # same tier as project_create — an ic may work cards but not schedule them.
    for a in ("loop_create", "loop_update", "loop_delete"):
        assert orglogic.allowed(a, "ic") is False, a
        assert orglogic.allowed(a, "lead") is True, a
        assert orglogic.allowed(a, "manager") is True, a


def test_creating_or_editing_a_loop_is_green_but_deleting_is_red():
    # Create/update stay green: a harman loop cannot FIRE until the owner licenses
    # its origin via the loop-control mode, so authoring one is not itself risky.
    # Delete is irreversible (takes its run history with it) → red → queued.
    assert orglogic.is_red("loop_create") is False
    assert orglogic.is_red("loop_update") is False
    assert orglogic.is_red("loop_delete") is True


def test_setting_the_loop_mode_is_manager_scoped_and_green():
    # The loop-control dropdown is an org-wide panel — manager tier, same as
    # harman_config. Green in both directions: de-escalating ('none'/'user') must
    # be cheap, and licensing already-authored loops only decides WHETHER they run.
    assert orglogic.allowed("loop_mode_set", "lead") is False
    assert orglogic.allowed("loop_mode_set", "manager") is True
    assert orglogic.is_red("loop_mode_set") is False


# ── mutates_own_session(): a session may not reschedule its own supervision ────

def test_a_session_may_not_mutate_its_own_loop():
    # The self-mutation rail: the acting session id equals the target it would
    # change, so the request is refused upstream (the route sends 403).
    assert orglogic.mutates_own_session("sX", "sX") is True


def test_a_session_may_mutate_another_sessions_loop():
    # Managing OTHER workers' schedules is the whole point of the tier.
    assert orglogic.mutates_own_session("sX", "sY") is False


def test_a_human_at_the_ui_is_never_caught_by_the_rail():
    # A human carries no acting session (empty), so the rail never fires on them —
    # only an MCP agent request carries a non-empty acting session id.
    assert orglogic.mutates_own_session("", "sX") is False
    assert orglogic.mutates_own_session("", "") is False
    # And a target that failed to resolve cannot accidentally match an agent caller.
    assert orglogic.mutates_own_session("sX", "") is False


# ── Harman planning (project_columns / suitable_employee / plan_assignments) ──

COLS = [
    {"id": 1, "name": "Todo", "position": 0},
    {"id": 2, "name": "Doing", "position": 1},
    {"id": 3, "name": "Review", "position": 2},
    {"id": 4, "name": "Done", "position": 3},
]


def test_project_columns_by_name():
    s = orglogic.project_columns(COLS)
    assert s == {"todo": 1, "doing": 2, "review": 3, "done": 4}


def test_project_columns_fallback_position():
    cols = [{"id": 9, "name": "Backlog", "position": 0}, {"id": 8, "name": "WIP", "position": 1}, {"id": 7, "name": "Shipped", "position": 2}]
    s = orglogic.project_columns(cols)
    assert s["todo"] == 9 and s["done"] == 7 and s["doing"] == 8


def test_suitable_employee_role_match_then_first():
    emps = [{"id": 1, "name": "Ann", "role": "designer", "status": "active"},
            {"id": 2, "name": "Bob", "role": "ios dev", "status": "active"}]
    assert orglogic.suitable_employee({"title": "Fix the iOS dev crash"}, emps)["id"] == 2
    assert orglogic.suitable_employee({"title": "Write docs"}, emps)["id"] == 1  # first active
    assert orglogic.suitable_employee({"title": "x"}, [{"id": 3, "status": "paused"}]) is None


def test_suitable_employee_excludes_manager_and_ceo():
    # The CEO/manager (first in the list) must NOT be picked to work a card — only doers.
    emps = [{"id": 1, "name": "Ram", "role": "Founder/CEO", "status": "active"},
            {"id": 2, "name": "Harman", "role": "Manager", "status": "active"},
            {"id": 3, "name": "Ada", "role": "Engineer", "status": "active"}]
    assert orglogic.suitable_employee({"title": "do the thing"}, emps)["id"] == 3


def test_suitable_employee_prefers_spawnable_worker():
    # With an org default provider absent, prefer the worker that has its own provider.
    emps = [{"id": 1, "name": "Ann", "role": "eng", "status": "active", "provider": ""},
            {"id": 2, "name": "Bob", "role": "eng", "status": "active", "provider": "p1"}]
    assert orglogic.suitable_employee({"title": "x"}, emps)["id"] == 2
    # A default provider makes everyone spawnable → first worker (role order) wins again.
    assert orglogic.suitable_employee({"title": "x"}, emps, default_provider="d")["id"] == 1


def test_plan_prefers_spawnable_worker_over_ceo():
    emps = [{"id": 1, "name": "Ram", "role": "Founder/CEO", "status": "active"},
            {"id": 3, "name": "Ada", "role": "Engineer", "status": "active", "provider": "p1"}]
    actions = orglogic.plan_assignments([_card(100)], emps, COLS, running=set(),
                                        projects=[10], budget=2)
    assert actions[0]["employee"] == 3 and actions[0]["spawn"] is True


def _card(id, project=10, column=1, assignee=None, **extra):
    return {"id": id, "project_id": project, "column_id": column, "assignee": assignee, **extra}


def test_plan_assigns_unassigned_todo_in_managed_project():
    emps = [{"id": 1, "name": "Ann", "role": "", "status": "active"}]
    actions = orglogic.plan_assignments([_card(100)], emps, COLS, running=set(), projects=[10], budget=2)
    assert len(actions) == 1
    a = actions[0]
    assert a["kind"] == "assign" and a["card_id"] == 100 and a["employee"] == 1 and a["spawn"] is True


def test_plan_skips_unmanaged_project():
    emps = [{"id": 1, "status": "active"}]
    assert orglogic.plan_assignments([_card(100, project=99)], emps, COLS, running=set(), projects=[10], budget=2) == []


def test_plan_skips_running_card():
    emps = [{"id": 1, "status": "active"}]
    assert orglogic.plan_assignments([_card(100)], emps, COLS, running={100}, projects=[10], budget=2) == []


def test_plan_budget_caps_spawns_not_assigns():
    emps = [{"id": 1, "status": "active"}]
    cards = [_card(1), _card(2), _card(3)]
    actions = orglogic.plan_assignments(cards, emps, COLS, running=set(), projects=[10], budget=2)
    # all three assigned, but only two spawned (budget=2)
    assert len(actions) == 3
    assert sum(1 for a in actions if a["spawn"]) == 2


def test_plan_advance_doing_when_session_done():
    emps = [{"id": 1, "status": "active"}]
    cards = [_card(5, column=2, assignee=1, _session_done_ok=True)]
    actions = orglogic.plan_assignments(cards, emps, COLS, running=set(), projects=[10], budget=2)
    assert actions == [{"kind": "advance", "card_id": 5, "to_column": 3, "reason": "session finished ok → Review"}]


def test_plan_no_employee_no_action():
    assert orglogic.plan_assignments([_card(1)], [], COLS, running=set(), projects=[10], budget=2) == []


# ── build_skill_md ───────────────────────────────────────────────────────────

def test_build_skill_md_frontmatter_and_body():
    md = orglogic.build_skill_md("ship-flow", "when shipping the app", "1. sync\n2. build", origin_employee="Emma")
    assert md.startswith("---\nname: ship-flow\ndescription: when shipping the app\n---\n")
    assert "1. sync\n2. build" in md
    assert "_Learned by Emma._" in md
    assert md.endswith("\n")


def test_build_skill_md_no_origin_and_blank_trigger():
    md = orglogic.build_skill_md("x", "", "do it")
    assert "description: x" in md  # falls back to the name
    assert "_Learned by" not in md


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
