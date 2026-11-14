"""ownercall.decide: every verdict, with owner-zone pinned clocks."""
from datetime import datetime
from zoneinfo import ZoneInfo

from orchestrator import actions, orglogic, ownercall, push

LA = ZoneInfo("America/Los_Angeles")
REASON = "Release is blocked and the deadline is today"


def at(h, m=0, day=14):
    return datetime(2026, 11, day, h, m, tzinfo=LA)


def go(now=None, level="lead", reason=REASON, card=5, rings=(), parent=False):
    return ownercall.decide(now or at(12), level, reason, card, list(rings), parent)["verdict"]


def test_ring_when_everything_is_in_order():
    assert go() == "ring"
    assert go(level="manager") == "ring"


def test_reason_and_card_required():
    assert go(reason="urgent") == "refuse"
    assert go(reason=None) == "refuse"
    assert go(card=0) == "refuse"
    assert go(card="x") == "refuse"


def test_low_level_escalates_or_refuses():
    assert go(level="ic", parent=True) == "escalate"
    assert go(level="ic") == "refuse"


def test_quiet_hours_in_owner_zone():
    assert go(at(7, 59)) == "refuse"
    assert go(at(8)) == "ring"
    assert go(at(20, 59)) == "ring"
    assert go(at(21)) == "refuse"


def test_gap_between_rings():
    assert go(rings=[at(11).timestamp()]) == "refuse"
    assert go(rings=[at(9, 30).timestamp()]) == "ring"


def test_daily_cap():
    rings = [at(8).timestamp(), at(10, 30).timestamp(), at(13).timestamp()]
    assert go(at(16), rings=rings) == "refuse"
    assert go(at(16), rings=[r - 86400 for r in rings]) == "ring"


def test_action_is_registered_and_open_to_every_level():
    assert "owner_call_request" in actions.ACTIONS
    assert orglogic._MIN_LEVEL["owner_call_request"] == "ic"
