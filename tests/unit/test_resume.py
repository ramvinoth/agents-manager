"""viewer.resume — boot resumes turns a server restart cut off, so an update
or crash pauses agent work instead of dropping it. Storage is faked; the
launcher is injected."""
import pytest

from viewer import db, questions, resume, inbox


@pytest.fixture
def store(monkeypatch):
    rows = {}
    told = []
    monkeypatch.setattr(db, "inflight_runs_all", lambda: [dict(r) for r in rows.values()])
    monkeypatch.setattr(db, "inflight_run_clear", lambda sid, started=None: rows.pop(sid, None))

    def bump(sid):
        rows[sid]["resumes"] += 1
    monkeypatch.setattr(db, "inflight_run_bump_resumes", bump)
    monkeypatch.setattr(db, "pending_question_get_open", lambda sid: None)
    monkeypatch.setattr(questions, "get_open_plan", lambda sid: None)
    monkeypatch.setattr(inbox, "deliver_message",
                        lambda *a, **k: told.append((a, k)))
    return rows, told


def _row(sid, resumes=0, queue=()):
    return {"session_id": sid, "host": "local", "cwd": "/tmp", "mode": "acceptEdits",
            "model": "", "queue": list(queue), "resumes": resumes, "started_at": 1.0}


def _run(start):
    return resume.resume_inflight(start=start, sleep=lambda s: None)


def test_cut_turn_is_resumed_and_counted(store):
    rows, _ = store
    rows["a"] = _row("a")
    launched = []
    assert _run(lambda r: launched.append(r["session_id"]) or True) == ["a"]
    assert launched == ["a"]
    # Row stays (the resumed run re-records it); the counter remembers this resume.
    assert rows["a"]["resumes"] == 1


def test_session_waiting_on_owner_is_left_to_the_answer(store, monkeypatch):
    rows, _ = store
    rows["q"] = _row("q")
    monkeypatch.setattr(db, "pending_question_get_open", lambda sid: {"tool_use_id": "t"})
    assert _run(lambda r: pytest.fail("must not launch")) == []
    assert "q" not in rows


def test_repeat_crasher_stops_and_asks_owner(store):
    rows, told = store
    rows["c"] = _row("c", resumes=resume.MAX_RESUMES)
    assert _run(lambda r: pytest.fail("must not launch")) == []
    assert "c" not in rows
    (args, kwargs), = told
    assert args[2] == "user" and args[4].startswith("Should I keep retrying")
    assert kwargs == {"wake": False}


def test_failed_launch_drops_the_row(store):
    rows, _ = store
    rows["b"] = _row("b")
    assert _run(lambda r: False) == []
    assert "b" not in rows


def test_one_bad_row_does_not_stop_the_rest(store):
    rows, _ = store
    rows["x"] = _row("x")
    rows["y"] = _row("y")

    def start(r):
        if r["session_id"] == "x":
            raise RuntimeError("boom")
        return True
    assert _run(start) == ["y"]


def test_start_requeues_backlog(monkeypatch):
    from viewer import engine, ai, config
    sent = {}
    monkeypatch.setattr(config, "transcript_path", lambda sid: "/x.jsonl")
    monkeypatch.setattr(db, "session_meta_get", lambda sid: {})
    monkeypatch.setattr(ai, "resolve", lambda meta, model, host: {
        "provider": "", "model": "opus", "preset": None, "effort": "high"})
    monkeypatch.setattr(engine, "start_claude_run",
                        lambda sid, args, msg, mode, cwd, model, host, provider_env=None, effort="":
                        sent.update(sid=sid, args=args, msg=msg, mode=mode, model=model,
                                    effort=effort) or True)
    q = []
    monkeypatch.setattr(engine, "enqueue_chat", lambda sid, m: q.append(m))
    assert resume._start(_row("s", queue=["next one", "and this"])) is True
    assert sent["args"] == ["--resume", "s"] and sent["msg"] == resume.RESUME_PROMPT
    assert sent["mode"] == "acceptEdits" and sent["model"] == "opus" and sent["effort"] == "high"
    assert q == ["next one", "and this"]


def test_start_skips_session_without_transcript(monkeypatch):
    from viewer import config
    monkeypatch.setattr(config, "transcript_path", lambda sid: None)
    assert resume._start(_row("s")) is False


def test_was_cut_off_only_when_nobody_decided_the_turn_should_end():
    assert resume.was_cut_off(turn_open=True, interrupted=False, explained=False)
    assert not resume.was_cut_off(turn_open=False, interrupted=False, explained=False)  # finished
    assert not resume.was_cut_off(turn_open=True, interrupted=True, explained=False)   # owner's Esc
    assert not resume.was_cut_off(turn_open=True, interrupted=False, explained=True)   # pushed reason


def test_resume_one_counts_and_stops_at_the_cap(store):
    rows, told = store
    rows["d"] = _row("d")
    launched = []
    for _ in range(resume.MAX_RESUMES):
        assert resume.resume_one(dict(rows["d"]), lambda r: launched.append(1) or True)
    assert len(launched) == resume.MAX_RESUMES
    assert not resume.resume_one(dict(rows["d"]), lambda r: pytest.fail("must not launch"))
    assert "d" not in rows and told[0][0][4].startswith("Should I keep retrying")


def test_engine_resumes_a_run_that_died_mid_turn(monkeypatch):
    """The finalizer's hand-off: the run's own row (with its leftovers) goes to
    resume_one; a row a newer run already replaced is left alone."""
    from viewer import engine
    monkeypatch.setattr(engine, "RESUME_SETTLE", 0)
    got = []
    monkeypatch.setattr(resume, "resume_one", lambda row: got.append(row) or True)
    job = {"started": 5.0, "returncode": -15}
    monkeypatch.setattr(db, "inflight_run_get",
                        lambda sid, started: _row(sid) if started == 5.0 else None)
    assert engine._resume_cut_turn("s", job, ["queued"]) is True
    assert got[0]["session_id"] == "s" and got[0]["queue"] == ["queued"]
    job["started"] = 6.0
    assert engine._resume_cut_turn("s", job, []) is False
