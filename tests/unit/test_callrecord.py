"""CallRecorder: the call-evidence layer (card 470). Hermetic — the recordings
directory and the DB flush are both monkeypatched, so a run never touches the
owner's real recordings or the database."""
import json
import os
import time
from unittest.mock import Mock

import pytest

from orchestrator import callrecord, config


def test_safe_call_id():
    assert callrecord.safe_call_id("abcdef-123") == "abcdef-123"
    assert callrecord.safe_call_id("a/b\\c:d") == "a_b_c_d"
    assert callrecord.safe_call_id("x" * 80) == "x" * 64
    assert callrecord.safe_call_id("") == "call"
    assert callrecord.safe_call_id(None) == "call"
    assert callrecord.safe_call_id(42) == "42"


def test_two_streams_align_to_the_event_timeline(tmp_path, monkeypatch):
    flushed = {}
    monkeypatch.setattr("orchestrator.db.call_events_insert",
                        lambda cid, ev: flushed.update(id=cid, events=ev))
    monkeypatch.setattr(config, "CALL_RECORDINGS_DIR", tmp_path / "recs")

    rec = callrecord.CallRecorder("sid-1")
    assert rec.enabled

    rec.caller(b"01234567")          # 8 bytes of caller input
    rec.event("asr", sub="user_turn_taken", turn=1, text="hello there")
    rec.reply(b"abc")                # 3 bytes of reply voice
    rec.event("tts", sub="closed", text="hi", chunks=3, bytes=3, first_s=0.05, barged=False)
    rec.close("stop")

    assert flushed["id"] == "sid-1"
    events = flushed["events"]
    asr = next(e for e in events if e["kind"] == "asr")
    assert asr["caller_bytes"] == 8 and asr["reply_bytes"] == 0
    assert asr["sub"] == "user_turn_taken" and asr["turn"] == 1
    assert asr["text"] == "hello there"
    tts = next(e for e in events if e["kind"] == "tts")
    assert tts["caller_bytes"] == 8 and tts["reply_bytes"] == 3
    assert json.loads(tts["detail"]) == {"chunks": 3, "bytes": 3, "first_s": 0.05, "barged": False}
    # The timeline is ordered, its abs times are real epochs, and it ends
    # with the stop event carrying the totals.
    assert all(b["ts"] >= a["ts"] for a, b in zip(events, events[1:]))
    assert all(e["abs_ts"] > 1e9 for e in events)
    assert events[-1]["kind"] == "stop" and events[-1]["sub"] == "stop"
    # The raw files hold exactly what was written.
    d = tmp_path / "recs"
    assert (d / "sid-1.caller.pcm").read_bytes() == b"01234567"
    assert (d / "sid-1.reply.pcm").read_bytes() == b"abc"
    assert d.stat().st_mode & 0o777 == 0o700    # the owner's voice is private


def test_close_is_idempotent(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr("orchestrator.db.call_events_insert",
                        lambda cid, ev: calls.append((cid, ev)))
    monkeypatch.setattr(config, "CALL_RECORDINGS_DIR", tmp_path / "recs")
    rec = callrecord.CallRecorder("s")
    rec.event("start")
    rec.close("stop")
    rec.close("stop")                    # a second close must not re-flush
    rec.caller(b"x")                     # a write after close is a silent no-op
    assert len(calls) == 1


def test_disabled_recorder_is_a_noop(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr("orchestrator.db.call_events_insert",
                        lambda cid, ev: calls.append((cid, ev)))
    monkeypatch.setattr(config, "CALL_RECORDINGS_DIR", tmp_path / "recs")
    rec = callrecord.CallRecorder("s", enabled=False)
    rec.caller(b"123")
    rec.event("start")
    rec.close("stop")
    assert not calls
    assert not list((tmp_path / "recs").glob("*"))


def test_open_failure_degrades_to_noop(tmp_path, monkeypatch, capsys):
    # The recordings dir cannot be created (a regular file blocks the path):
    # the recorder must disable itself, never raise into the call, and never flush.
    blocker = tmp_path / "blocker"
    blocker.write_text("a regular file, not a directory")
    monkeypatch.setattr(config, "CALL_RECORDINGS_DIR", blocker / "recs")
    calls = []
    monkeypatch.setattr("orchestrator.db.call_events_insert",
                        lambda cid, ev: calls.append((cid, ev)))
    rec = callrecord.CallRecorder("s")
    assert rec.enabled is False
    rec.caller(b"123")
    rec.event("start")
    rec.close("stop")                   # must not raise
    assert not calls
    assert capsys.readouterr().out.startswith("[callrecord] open failed")


def test_flush_failure_never_breaks_the_call(tmp_path, monkeypatch, capsys):
    # A down database must never break a live call: close() swallows the flush
    # error and still closes the files.
    monkeypatch.setattr("orchestrator.db.call_events_insert",
                        Mock(side_effect=RuntimeError("db down")))
    monkeypatch.setattr(config, "CALL_RECORDINGS_DIR", tmp_path / "recs")
    rec = callrecord.CallRecorder("s")
    rec.event("start")
    rec.close("error")                  # must not raise even with the DB down
    assert "flush failed" in capsys.readouterr().out


def test_purge_files_drops_only_stale_pcm(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CALL_RECORDINGS_DIR", tmp_path / "recs")
    d = tmp_path / "recs"
    d.mkdir()
    old = d / "old.caller.pcm"
    old.write_bytes(b"x")
    new = d / "new.reply.pcm"
    new.write_bytes(b"y")
    notes = d / "old.notes.txt"        # not audio: never touched
    notes.write_text("keep")
    old_mtime = time.time() - 20 * 86400
    for p in (old, notes):
        os.utime(p, (old_mtime, old_mtime))
    callrecord.purge_files(14)
    assert not old.exists()
    assert new.exists()
    assert notes.exists()
    callrecord.purge_files(0)          # disabled retention: nothing removed
    assert new.exists()


def test_purge_files_missing_dir_is_safe(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CALL_RECORDINGS_DIR", tmp_path / "nope")
    callrecord.purge_files(14)         # no directory yet: no error
