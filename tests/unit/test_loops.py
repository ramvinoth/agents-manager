"""Pure scheduling logic for viewer.loops — the one-shot ("at") kind and the
build_schedule precedence (cron > at > interval). No db, no I/O: `now` is
injected everywhere.
"""
from datetime import datetime

from viewer.loops import build_schedule, parse_interval, parse_when

NOW = 1_799_000_000.0  # arbitrary fixed "now"


class TestParseWhen:
    def test_relative_units(self):
        assert parse_when("30m", now=NOW) == NOW + 1800
        assert parse_when("2h", now=NOW) == NOW + 7200
        assert parse_when("1d", now=NOW) == NOW + 86400
        assert parse_when("90", now=NOW) == NOW + 90  # plain seconds

    def test_relative_clamped(self):
        assert parse_when("5s", now=NOW) == NOW + 10      # 10s floor
        assert parse_when("30d", now=NOW) == NOW + 604800  # 7d cap

    def test_absolute_local(self):
        assert parse_when("2026-09-17 21:00", now=NOW) == \
            datetime(2026, 9, 17, 21, 0).timestamp()
        assert parse_when("2026-09-17T21:00:00", now=NOW) == \
            datetime(2026, 9, 17, 21, 0).timestamp()

    def test_absolute_date_only_is_midnight(self):
        assert parse_when("2026-09-17", now=NOW) == \
            datetime(2026, 9, 17, 0, 0).timestamp()

    def test_invalid(self):
        assert parse_when("abc", now=NOW) is None
        assert parse_when("", now=NOW) is None
        assert parse_when("2026-13-40 99:99", now=NOW) is None  # bad month/hour
        assert parse_when(None, now=NOW) is None


class TestBuildScheduleOnce:
    def test_at_only_is_once(self):
        fields, err = build_schedule(None, None, "30m", now=NOW)
        assert err is None
        assert fields == {"cron": None, "interval": 0, "kind": "once",
                          "nextRun": NOW + 1800}

    def test_at_absolute(self):
        fields, err = build_schedule(None, None, "2026-09-17 21:00", now=NOW)
        assert err is None
        assert fields["kind"] == "once"
        assert fields["nextRun"] == datetime(2026, 9, 17, 21, 0).timestamp()

    def test_bad_at_is_error(self):
        fields, err = build_schedule(None, None, "someday", now=NOW)
        assert fields is None
        assert "at" in err

    def test_cron_wins_over_at(self):
        fields, err = build_schedule("0 9 * * *", None, "30m", now=NOW)
        assert err is None
        assert fields["kind"] == "recurring"
        assert fields["cron"] == "0 9 * * *"

    def test_at_wins_over_interval(self):
        fields, err = build_schedule(None, "5m", "2h", now=NOW)
        assert err is None
        assert fields["kind"] == "once"
        assert fields["nextRun"] == NOW + 7200

    def test_interval_still_recurring(self):
        fields, err = build_schedule(None, "5m", None, now=NOW)
        assert err is None
        assert fields == {"cron": None, "interval": 300, "kind": "recurring",
                          "nextRun": NOW + 300}

    def test_nothing_given_mentions_at(self):
        fields, err = build_schedule(None, None, None, now=NOW)
        assert fields is None
        assert "at" in err and "cron" in err and "interval" in err


class TestParseIntervalUnchanged:
    def test_bounds_still_hold(self):
        assert parse_interval("1s") == 30
        assert parse_interval("100h") == 86400
