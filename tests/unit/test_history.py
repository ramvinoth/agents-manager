"""viewer.history: the rows a transcript trim drops stay browsable.

Each test builds a fake projects/<dir>/<sid>.jsonl, snapshots it, then mimics
the CLI's trim (a NEW file holding a few earlier rows plus new ones, swapped in
with rename, like CLAUDE_CODE_TRANSCRIPT_LOCAL_GC does) and checks the virtual
archive+live file holds every row exactly once, in order."""
import json
import os
import subprocess
import sys

import pytest

from viewer import history
from viewer.config import read_back_f, split_lines


def _row(i, kind="user"):
    return json.dumps({"type": kind, "uuid": f"u{i}", "n": i}, separators=(",", ":")) + "\n"


@pytest.fixture
def live(tmp_path):
    d = tmp_path / "projects" / "-tmp-proj"
    d.mkdir(parents=True)
    p = d / "sid.jsonl"
    p.write_text("".join(_row(i) for i in range(10)))
    return p


def _append(p, rows):
    with open(p, "a") as f:
        f.write("".join(rows))


def _trim(p, keep, new):
    """The CLI's trim: write a new inode holding `keep` old rows + `new`."""
    tmp = p.with_name(p.name + ".tmp")
    tmp.write_text("".join(keep) + "".join(new))
    os.replace(tmp, p)


def _all(p):
    with history.HistoryView(p) as v:
        return [line.decode() + "\n" for line in v.lines() if line]


def _pendings(p):
    return history._pendings(p)


def test_untrimmed_chat_reads_as_the_plain_file(live):
    with history.HistoryView(live) as v:
        assert v.gen == 0 and v.a_size == 0
        assert v.size == live.stat().st_size
        assert history.encode(v.gen, 123) == 123   # offsets clients already hold


def test_one_trim_keeps_every_row(live):
    history.snapshot(live)
    _append(live, [_row(10)])
    _trim(live, keep=[_row(0), _row(9)], new=[_row(11, "summary")])
    history.settle(live)
    rows = _all(live)
    # dropped rows first (in order), then the live file as the CLI wrote it
    assert rows == [_row(i) for i in range(1, 9)] + [_row(10)] + [_row(0), _row(9), _row(11, "summary")]
    assert _pendings(live) == []


def test_two_trims_in_one_run_fold_in_order(live):
    history.snapshot(live)                       # spawn
    history.snapshot(live)                       # PreCompact 1 (same inode)
    _trim(live, keep=[_row(9)], new=[_row(20)])
    _append(live, [_row(21), _row(22)])
    history.snapshot(live)                       # PreCompact 2
    _trim(live, keep=[_row(22)], new=[_row(30)])
    history.finish_run(live, before_ns=10**30)
    rows = _all(live)
    assert rows == [_row(i) for i in range(9)] + [_row(9), _row(20), _row(21)] + [_row(22), _row(30)]
    assert _pendings(live) == []


def test_compaction_without_trim_leaves_nothing_behind(live):
    history.snapshot(live)
    _append(live, [_row(10)])
    history.finish_run(live, before_ns=10**30)
    assert _pendings(live) == []
    assert _all(live) == [_row(i) for i in range(11)]


def test_finish_run_keeps_the_next_runs_snapshot(live):
    import time
    cutoff = time.time_ns()
    nxt = history.snapshot(live)                  # next run spawned before the fold ran
    history.finish_run(live, before_ns=cutoff)
    assert _pendings(live) == [nxt]


def test_crash_mid_append_is_cut_back(live):
    history.snapshot(live)
    _trim(live, keep=[], new=[_row(50)])
    history.settle(live)
    _, archive, meta, _, _ = history._paths(live)
    good = archive.read_bytes()
    with open(archive, "ab") as f:
        f.write(b'{"partial":')                 # a fold that died mid-write
    history.snapshot(live)
    _trim(live, keep=[], new=[_row(51)])
    history.settle(live)
    assert archive.read_bytes() == good + _row(50).encode()


def test_crash_after_commit_before_unlink(live):
    p = history.snapshot(live)
    _trim(live, keep=[], new=[_row(50)])
    history.settle(live)
    _, archive, meta, _, _ = history._paths(live)
    size = archive.stat().st_size
    # replay: the snapshot is back but the meta says it was folded
    os.link(live, p)
    m = json.loads(meta.read_text())
    m["done"].append(p.name)
    meta.write_text(json.dumps(m))
    history.settle(live)
    assert archive.stat().st_size == size and _pendings(live) == []


def test_offsets_change_generation_at_each_fold(live):
    with history.HistoryView(live) as v:
        old = history.encode(v.gen, v.size)
    history.snapshot(live)
    _trim(live, keep=[], new=[_row(60)])
    with history.HistoryView(live) as v:         # folds inline: small chat
        assert v.gen != 0
        assert history.decode(v.gen, old) is None
        assert history.decode(v.gen, 0) == 0
        end = history.encode(v.gen, v.size)
        assert history.decode(v.gen, end) == v.size
        assert end < 2 ** 53


def test_read_back_crosses_the_archive_boundary(live):
    history.snapshot(live)
    _trim(live, keep=[], new=[_row(70), _row(71)])
    history.settle(live)
    with history.HistoryView(live) as v:
        start, data = read_back_f(v, v.size, 4)
        lines, end = split_lines(data, start)
        assert [json.loads(x)["n"] for x in lines] == [8, 9, 70, 71]
        assert start < v.a_size < end == v.size
        assert v.at_line_start(start) and not v.at_line_start(start + 1)


def test_view_never_reads_past_its_size(live):
    with history.HistoryView(live) as v:
        size = v.size
        _append(live, [_row(99)])
        v.seek(0)
        assert len(v.read()) == size


def test_hook_snapshots_and_never_fails(live):
    script = os.path.join(os.path.dirname(history.__file__), "history.py")
    payload = json.dumps({"transcript_path": str(live), "session_id": "sid"})
    r = subprocess.run([sys.executable, "-I", script], input=payload, text=True)
    assert r.returncode == 0 and len(_pendings(live)) == 1
    r = subprocess.run([sys.executable, "-I", script], input="not json", text=True)
    assert r.returncode == 0


def test_summary_counts_the_whole_history(live):
    from viewer.sessions import compute_session_summary
    history.snapshot(live)
    _trim(live, keep=[], new=[_row(80)])
    with history.HistoryView(live) as v:
        assert compute_session_summary(v.lines(), "/x")["lines"] == 11



def test_repeated_identical_rows_keep_every_copy(live):
    mode = json.dumps({"type": "mode", "mode": "normal"}) + "\n"
    _append(live, [mode, _row(10), mode, _row(11), mode])
    history.snapshot(live)
    _trim(live, keep=[mode], new=[_row(12)])
    history.settle(live)
    rows = _all(live)
    assert rows.count(mode) == 3
    assert [r for r in rows if r != mode] == [_row(i) for i in range(13)]
