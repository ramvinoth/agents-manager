"""engine._session_title reads a transcript's head once per (mtime, size) —
the decision feed calls it for every open decision on a 4 s poll, so an
uncached parse is an N+1 disk read on a hot path (card #100). A changed
transcript (a title set later) still refreshes the cached name."""
import json
import os

from viewer import engine


def _write(path, lines):
    path.write_text("".join(json.dumps(x) + "\n" for x in lines))


def test_title_is_read_once_until_the_transcript_changes(tmp_path, monkeypatch):
    p = tmp_path / "s1.jsonl"
    _write(p, [{"type": "user", "message": {"content": "hello there"}}])
    monkeypatch.setattr(engine, "transcript_path", lambda sid: p)
    monkeypatch.setattr(engine, "_TITLE_CACHE", {})
    reads = []
    real = engine._read_session_title
    monkeypatch.setattr(engine, "_read_session_title", lambda path: reads.append(path) or real(path))

    assert engine._session_title("s1") == "hello there"
    assert engine._session_title("s1") == "hello there"
    assert len(reads) == 1

    _write(p, [{"type": "custom-title", "customTitle": "Login fix"}])
    os.utime(p, (p.stat().st_atime, p.stat().st_mtime + 5))
    assert engine._session_title("s1") == "Login fix"
    assert len(reads) == 2


def test_missing_transcript_is_empty_and_not_cached(tmp_path, monkeypatch):
    monkeypatch.setattr(engine, "transcript_path", lambda sid: tmp_path / "nope.jsonl")
    monkeypatch.setattr(engine, "_TITLE_CACHE", {})
    assert engine._session_title("s2") == ""
    assert engine._TITLE_CACHE == {}
