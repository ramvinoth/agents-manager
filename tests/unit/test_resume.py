"""orchestrator.resume — boot resumes turns a server restart cut off, so an update
or crash pauses agent work instead of dropping it. Storage is faked; the
launcher is injected."""
import pytest

from orchestrator import db, questions, resume, inbox


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
    from orchestrator import engine, ai, config, turn
    sent = {}
    monkeypatch.setattr(config, "transcript_path", lambda sid: "/x.jsonl")
    monkeypatch.setattr(db, "session_meta_get", lambda sid: {})
    monkeypatch.setattr(ai, "resolve", lambda meta, model, host: {
        "provider": "", "model": "opus", "preset": None, "effort": "high", "convMode": "agent"})
    monkeypatch.setattr(turn, "start_claude_run",
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
    from orchestrator import config
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
    assert "server restart" in told[0][0][4]


def test_the_cap_ask_quotes_the_last_error(store):
    rows, told = store
    rows["e"] = dict(_row("e"), resumes=resume.MAX_RESUMES)
    assert resume.capped(rows["e"])
    assert not resume.resume_one(dict(rows["e"]), lambda r: pytest.fail("must not launch"),
                                 reason="BrokenPipeError: [Errno 32] Broken pipe")
    assert "The last error was: BrokenPipeError" in told[0][0][4]


def test_a_capped_run_does_not_also_push_a_generic_error(monkeypatch):
    """At the cap the owner is asked in the inbox; the finalizer must know, so
    it skips the vaguer 'The run ended with an error.' push."""
    from orchestrator.runtime import chat
    monkeypatch.setattr(chat, "RESUME_SETTLE", 0)
    monkeypatch.setattr(resume, "resume_one", lambda row, reason="": False)
    monkeypatch.setattr(db, "inflight_run_get",
                        lambda sid, started: dict(_row(sid), resumes=resume.MAX_RESUMES))
    job = {"started": 5.0, "returncode": -1, "stderr": "x"}
    assert chat._resume_cut_turn("s", job, []) is False and job["owner_told"]


def test_engine_resumes_a_run_that_died_mid_turn(monkeypatch):
    """The finalizer's hand-off: the run's own row (with its leftovers) goes to
    resume_one; a row a newer run already replaced is left alone."""
    from orchestrator.runtime import chat
    monkeypatch.setattr(chat, "RESUME_SETTLE", 0)
    got = []
    monkeypatch.setattr(resume, "resume_one", lambda row, reason="": got.append(row) or True)
    job = {"started": 5.0, "returncode": -15}
    monkeypatch.setattr(db, "inflight_run_get",
                        lambda sid, started: _row(sid) if started == 5.0 else None)
    assert chat._resume_cut_turn("s", job, ["queued"]) is True
    assert got[0]["session_id"] == "s" and got[0]["queue"] == ["queued"]
    job["started"] = 6.0
    assert chat._resume_cut_turn("s", job, []) is False


def test_clients_fold_the_resume_prompt_by_its_opening():
    """The web and mobile transcripts fold the resume prompt into the reply by
    matching its opening words; rewording RESUME_PROMPT must update them too."""
    import pathlib, re
    root = pathlib.Path(__file__).resolve().parents[2]
    for f in ("web/src/lib/parser.ts", "mobile-app/src/lib/thread.ts"):
        mark = re.search(r'RESUME_MARK = "([^"]+)"', (root / f).read_text()).group(1)
        assert resume.RESUME_PROMPT.startswith(mark), f


class _Running:
    """A child process still mid-turn: communicate() blocks until the test lets
    it die (the restart's group SIGTERM)."""
    def __init__(self, gate):
        self.gate, self.returncode = gate, None

    def communicate(self, timeout=None):
        self.gate.wait(5)
        self.returncode = -15
        return "", "Terminated"

    def kill(self):
        pass


def test_every_harness_cut_by_a_restart_is_resumed_at_boot(monkeypatch, tmp_path):
    """One turn per harness is in flight when the server goes down; boot hands
    each back to its own harness with RESUME_PROMPT and what it needs to find
    the conversation again (codex id, pi session uuid, the session's AI)."""
    import threading
    import time
    import orchestrator.push
    import subprocess
    from orchestrator import ai, config, customrun, engine, turn
    from orchestrator.config import CHAT_JOBS
    from orchestrator.runtime import chat
    from orchestrator.runtime.runners import codex, copilot, pi

    # Durable store, faked with the real semantics: start upserts, clear only
    # removes the row of the run that recorded it.
    rows = {}

    def start(sid, host, cwd, mode, model, started, agent="claude", ref=None):
        rows[sid] = {"session_id": sid, "host": host, "cwd": cwd, "mode": mode,
                     "model": model, "started_at": started, "agent": agent,
                     "ref": ref or {}, "queue": [], "resumes": 0}

    def clear(sid, started=None):
        if sid in rows and started in (None, rows[sid]["started_at"]):
            rows.pop(sid)

    def bump(sid):
        rows[sid]["resumes"] += 1
    monkeypatch.setattr(db, "inflight_run_start", start)
    monkeypatch.setattr(db, "inflight_run_clear", clear)
    monkeypatch.setattr(db, "inflight_runs_all", lambda: [dict(r) for r in rows.values()])
    monkeypatch.setattr(db, "inflight_run_bump_resumes", bump)
    monkeypatch.setattr(db, "pending_question_get_open", lambda sid: None)
    monkeypatch.setattr(questions, "get_open_plan", lambda sid: None)
    monkeypatch.setattr(db, "session_meta_get", lambda sid: {"sid": sid})
    monkeypatch.setattr(chat, "RESUME_SETTLE", 0)
    monkeypatch.setattr(orchestrator.push, "notify_all", lambda *a, **k: None)

    # The runs: every spawn blocks mid-turn until `gate` fires.
    gate, ended = threading.Event(), []
    monkeypatch.setattr(subprocess, "Popen", lambda cmd, **kw: _Running(gate))

    def completion(*a):
        gate.wait(5)
        raise ConnectionError("server going down")
    monkeypatch.setattr(customrun, "_chat_completion", completion)
    monkeypatch.setattr(customrun, "transcript_path", lambda sid: None)
    monkeypatch.setattr(customrun, "CLAUDE_DIR", tmp_path)
    real_end = chat.end_oneshot_inflight

    def end(sid, job):
        real_end(sid, job)
        ended.append(sid)
    # customrun looks it up on the engine facade at call time; the runners import it by name.
    for owner in (engine, codex, copilot, pi):
        monkeypatch.setattr(owner, "end_oneshot_inflight", end)
    cwd = str(tmp_path)
    preset = {"baseUrl": "http://endpoint.invalid", "model": "local-27b"}
    sids = ["claude-1", "custom-1", "codex-1", "copilot-1", "pi-1"]
    for sid in sids:
        CHAT_JOBS.pop(sid, None)
    try:
        # start_claude_run records through this same helper before it spawns.
        engine.record_inflight("claude-1", {"started": 1.0, "host": "local", "cwd": cwd,
                                            "mode": "acceptEdits", "model": "opus"})
        assert customrun.start_custom_run("custom-1", "p1", "hi", cwd, preset=preset)
        assert engine.start_codex_run("codex-1", "cx-42", "fix it", cwd, "gpt-5")
        assert engine.start_copilot_run("copilot-1", "port it", cwd, "local", "", "plan")
        assert engine.start_pi_run("pi-1", "pi-uuid", "go", cwd, "anthropic", "m")
        assert {r["agent"] for r in rows.values()} == {"claude", "custom", "codex", "copilot", "pi"}

        # The restart: the process, and CHAT_JOBS with it, is gone; the rows stay.
        for sid in sids:
            CHAT_JOBS.pop(sid, None)

        launched = {}
        monkeypatch.setattr(config, "transcript_path", lambda sid: cwd + "/t.jsonl")
        monkeypatch.setattr(ai, "resolve", lambda meta, model, host: (
            {"provider": "p1", "model": "local-27b", "preset": preset, "effort": "",
             "convMode": "chat"} if meta["sid"] == "custom-1" else
            {"provider": "", "model": model, "preset": None, "effort": "", "convMode": "agent"}))
        monkeypatch.setattr(turn, "start_claude_run",
                            lambda sid, args, msg, mode, cwd, model, host, **k:
                            launched.setdefault(sid, ("claude", args, msg, mode, model)))
        monkeypatch.setattr(customrun, "start_custom_run",
                            lambda sid, pid, msg, cwd, host, mode, model=None, preset=None:
                            launched.setdefault(sid, ("custom", pid, msg, model)))
        monkeypatch.setattr(engine, "start_codex_run",
                            lambda sid, cid, msg, cwd, model, host:
                            launched.setdefault(sid, ("codex", cid, msg, model, host)))
        monkeypatch.setattr(engine, "start_copilot_run",
                            lambda sid, msg, cwd, host, model, mode:
                            launched.setdefault(sid, ("copilot", msg, host, mode)))
        monkeypatch.setattr(engine, "start_pi_run",
                            lambda sid, uuid, msg, cwd, provider, model:
                            launched.setdefault(sid, ("pi", uuid, msg, provider, model)))

        assert sorted(resume.resume_inflight(sleep=lambda s: None)) == sorted(sids)
        p = resume.RESUME_PROMPT
        assert launched == {
            "claude-1": ("claude", ["--resume", "claude-1"], p, "acceptEdits", "opus"),
            "custom-1": ("custom", "p1", p, "local-27b"),
            "codex-1": ("codex", "cx-42", p, "gpt-5", "local"),
            "copilot-1": ("copilot", p, "local", "plan"),
            "pi-1": ("pi", "pi-uuid", p, "anthropic", "m"),
        }
        assert all(rows[s]["resumes"] == 1 for s in sids)
    finally:
        gate.set()  # let the cut runs' threads finish before the fakes are undone
        deadline = time.time() + 5
        while len(ended) < 4 and time.time() < deadline:
            time.sleep(0.01)
        for sid in sids:
            CHAT_JOBS.pop(sid, None)
    assert sorted(ended) == sorted(sids[1:])


def test_oneshot_run_end_settles_before_clearing_a_failed_turn(monkeypatch):
    """A one-shot that exits non-zero may be dying in the restart's group
    SIGTERM: wait RESUME_SETTLE before clearing, so a server that goes down
    meanwhile leaves the row for boot. A clean exit or the owner's stop clears
    at once."""
    from orchestrator.runtime import chat
    slept, cleared = [], []
    monkeypatch.setattr(chat.time, "sleep", slept.append)
    monkeypatch.setattr(db, "inflight_run_clear", lambda sid, started: cleared.append((sid, started)))
    chat.end_oneshot_inflight("a", {"started": 1.0, "returncode": 0})
    assert slept == [] and cleared == [("a", 1.0)]
    chat.end_oneshot_inflight("b", {"started": 2.0, "returncode": -15})
    assert slept == [chat.RESUME_SETTLE] and cleared[-1] == ("b", 2.0)
    chat.end_oneshot_inflight("c", {"started": 3.0, "returncode": -1, "interrupted": True})
    assert slept == [chat.RESUME_SETTLE] and cleared[-1] == ("c", 3.0)
