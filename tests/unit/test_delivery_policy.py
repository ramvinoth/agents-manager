"""Pure contract tests for internal delivery schedule policy."""

from orchestrator import delivery_policy as policy


def _schedule(**changes):
    row = {
        "status": "planned",
        "priority": "normal",
        "timezone": "America/Los_Angeles",
        "starts_at": 100.0,
        "due_at": 200.0,
        "all_day": False,
        "estimated_duration_sec": 60,
        "owner_commitment": False,
    }
    row.update(changes)
    return row


def test_schedule_requires_an_iana_timezone_and_valid_time_order():
    assert policy.validate_schedule_fields(_schedule(), creating=True) is None
    assert policy.validate_schedule_fields(_schedule(timezone="not-a-zone"), creating=True) == \
        "timezone must be a valid IANA timezone"
    assert policy.validate_schedule_shape(_schedule(), {"starts_at": 201.0}) == \
        "starts_at must not be after due_at"


def test_all_day_schedule_requires_a_logical_day_boundary():
    assert policy.validate_schedule_shape(_schedule(starts_at=None, due_at=None), {"all_day": True}) == \
        "all_day schedules require a due_at day boundary"


def test_terminal_schedule_cannot_be_reopened_silently():
    assert policy.transition_allowed("completed", "active") is False
    assert policy.validate_mutation(_schedule(status="completed"), {"status": "active"},
                                    actor_kind="owner", reason="retry") == \
        "delivery schedule cannot move from completed to active"


def test_owner_commitment_needs_owner_and_reason_for_reschedule():
    current = _schedule(owner_commitment=True)
    change = {"due_at": 240.0}
    assert policy.mutation_authority(current, change, actor_kind="agent") == "propose"
    assert policy.validate_mutation(current, change, actor_kind="agent", reason="conflict") == \
        "owner commitment changes require an owner action; record a proposal instead"
    assert policy.validate_mutation(current, change, actor_kind="owner") == \
        "owner commitment changes require a reason"
    assert policy.validate_mutation(current, change, actor_kind="owner", reason="customer requested") is None


def test_agent_owned_work_can_be_rescheduled_under_the_same_policy():
    current = _schedule(owner_commitment=False)
    assert policy.mutation_authority(current, {"due_at": 240.0}, actor_kind="agent") == "apply"
    assert policy.validate_mutation(current, {"due_at": 240.0}, actor_kind="agent") is None


def test_recovery_requires_a_new_planned_due_boundary_and_reason():
    current = _schedule(status="completed")
    assert policy.validate_recovery(
        current, {"status": "planned", "due_at": 240.0}, actor_kind="owner",
        reason="New work arrived") is None
    assert policy.validate_recovery(
        current, {"status": "planned"}, actor_kind="owner", reason="again") == \
        "delivery recovery requires an explicit due_at"
    assert policy.validate_recovery(
        current, {"status": "planned", "due_at": 240.0}, actor_kind="owner") == \
        "delivery recovery requires a reason"
    assert policy.validate_recovery(
        _schedule(status="archived"), {"status": "planned", "due_at": 240.0},
        actor_kind="owner", reason="again") == \
        "only completed or cancelled delivery schedules can be recovered"


def test_agent_owner_commitment_proposal_is_validated_but_does_not_change_truth():
    current = _schedule(owner_commitment=True)
    assert policy.validate_proposal(current, {"due_at": 240.0}, reason="dependency conflict") is None
    assert policy.validate_proposal(current, {"due_at": 240.0}, reason="") == \
        "delivery proposals require a reason"
    assert policy.validate_proposal(current, {"priority": "high"}, reason="visibility") == \
        "proposals must change timing or delivery status"
    assert policy.validate_proposal(current, {"owner_commitment": False}, reason="remove") == \
        "an agent cannot propose changing owner commitment semantics"


def test_only_an_owner_can_create_an_owner_commitment():
    assert policy.validate_mutation(
        None,
        {"owner_commitment": True, "timezone": "America/Los_Angeles"},
        actor_kind="agent",
    ) == "only an owner may create an owner commitment"


def test_priority_order_is_stable_and_unknown_values_sink():
    assert [policy.priority_rank(p) for p in ("critical", "high", "normal", "low")] == [0, 1, 2, 3]
    assert policy.priority_rank("unknown") > policy.priority_rank("low")
