"""The owner's time zone is this server's zone, everywhere a time crosses to an
agent or the owner: calendar times without an offset, the per-run prompt line,
and the local twins on MCP timestamps. Each check runs in a child process with
TZ pinned (this Python has no time.tzset), in two zones, so a machine on UTC or
on Pacific cannot pass by accident."""
import json
import os
import subprocess
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PROBE = """
import json
from viewer.engine import owner_time_line
from viewer.viewer_mcp import with_local_times
from viewer.workspace import event_time
print(json.dumps({
    "naive": event_time("2026-11-05T09:00:00", False)["dateTime"],
    "zulu": event_time("2026-11-05T09:00:00Z", False)["dateTime"],
    "line": owner_time_line(),
    "mcp": with_local_times({"next_window": 1793944200,
                             "rows": [{"created_at": 1793944200000}],
                             "id": 1793944200, "at_count": 3, "at": "2h"}),
}))
"""
WANT = {
    "America/Los_Angeles": ("2026-11-05T09:00:00-08:00", "2026-11-05 9:50 PM PST"),
    "Asia/Kolkata": ("2026-11-05T09:00:00+05:30", "2026-11-06 11:20 AM IST"),
}


@pytest.fixture(params=sorted(WANT), scope="module")
def probe(request):
    out = subprocess.run([sys.executable, "-c", PROBE], cwd=ROOT, check=True,
                         capture_output=True, text=True,
                         env={**os.environ, "TZ": request.param})
    return request.param, json.loads(out.stdout)


def test_naive_calendar_time_is_local_not_utc(probe):
    zone, got = probe
    assert got["naive"] == WANT[zone][0]
    assert got["zulu"] == "2026-11-05T09:00:00+00:00"  # an explicit offset is kept


def test_prompt_line_names_the_zone(probe):
    zone, got = probe
    assert zone in got["line"] and "never in UTC" in got["line"]


def test_local_twins_in_owner_zone(probe):
    zone, got = probe
    mcp = got["mcp"]
    assert mcp["next_window_local"] == WANT[zone][1]
    assert mcp["rows"][0]["created_at_local"] == WANT[zone][1]
    assert mcp["next_window"] == 1793944200  # the epoch itself is kept
    assert not {"id_local", "at_count_local", "at_local"} & set(mcp)
