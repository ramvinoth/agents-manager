"""Unit tests for sandbox.turn: the pure parts of one sandboxed turn.

The lease itself needs Docker and a model endpoint, so run_turn is exercised with a
fake lease that behaves like a box: put/get round trip tar streams and exec plays
back stream-json. That checks the contract that matters, that state saved after a
turn is exactly what the next lease restores and resumes.
"""
import io
import json
import tarfile

from sandbox import turn


def _tar(files):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as t:
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            t.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def test_new_session_uses_session_id_and_resume_uses_resume():
    new = turn.claude_argv("hi", "abc", resume=False)
    old = turn.claude_argv("hi", "abc", resume=True)
    assert new[new.index("--session-id") + 1] == "abc" and "--resume" not in new
    assert old[old.index("--resume") + 1] == "abc" and "--session-id" not in old
    assert "-p" in new and "stream-json" in new


def test_project_dir_is_pinned_by_fixed_cwd():
    assert turn.WORKDIR == "/work"
    assert turn.PROJECT_DIR.endswith("/.claude/projects/-work")


def test_transcript_lines_reads_jsonl_from_state_tar():
    rows = [{"type": "user"}, {"type": "assistant"}]
    tar = _tar({"-work/s1.jsonl": "\n".join(json.dumps(r) for r in rows).encode() + b"\n"})
    assert turn.transcript_lines(tar, "s1") == rows
    assert turn.transcript_lines(tar, "other") == []
    assert turn.transcript_lines(None, "s1") == []


def test_store_round_trip_and_missing(tmp_path):
    s = turn.Store(tmp_path)
    assert s.get("s1", "workspace.tar") is None
    s.put("s1", "workspace.tar", b"x")
    assert s.get("s1", "workspace.tar") == b"x"
    assert not list(tmp_path.rglob("*.part"))


class FakeLease:
    """A box: what put stores, get returns; exec replays a scripted turn."""
    boxes = []

    def __init__(self, *a):
        self.fs, self.argv, self.env = {}, None, None
        FakeLease.boxes.append(self)

    def put(self, tar_bytes, dest):
        self.fs[dest] = tar_bytes

    def exec(self, argv, env_names, budget_s, on_line):
        self.argv, self.env = argv, env_names
        sid = argv[argv.index("--resume" if "--resume" in argv else "--session-id") + 1]
        prior = turn.transcript_lines(self.fs.get(turn.PROJECT_DIR), sid)
        rows = prior + [{"type": "user"}, {"type": "assistant"}]
        self.saved = {
            turn.WORKDIR: _tar({"work/note.txt": b"hello"}),
            turn.PROJECT_DIR: _tar({f"-work/{sid}.jsonl": "\n".join(json.dumps(r) for r in rows).encode()}),
        }
        on_line(json.dumps({"type": "result", "result": "ok", "total_cost_usd": 0.01}) + "\n")
        return 0, False

    def stderr_tail(self):
        return ""

    def get(self, path):
        return self.saved.get(path)

    def close(self):
        pass


def test_second_turn_restores_and_resumes(tmp_path, monkeypatch):
    monkeypatch.setattr(turn, "DockerLease", FakeLease)
    for n in turn.SECRET_ENV:
        monkeypatch.delenv(n, raising=False)   # the host's own env must not leak in
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k")
    store = turn.Store(tmp_path)
    first = turn.run_turn(store, "s1", "start")
    second = turn.run_turn(store, "s1", "next")
    assert first["status"] == second["status"] == "done"
    assert not first["resumed"] and second["resumed"]
    box = FakeLease.boxes[-1]
    assert "--resume" in box.argv and turn.WORKDIR in box.fs   # workspace came back
    assert box.env == ["ANTHROPIC_API_KEY"]                 # name only, never the value
    assert len(turn.transcript_lines(store.get("s1", "state.tar"), "s1")) == 4


def test_budget_stop_resumes_on_next_lease(tmp_path, monkeypatch):
    calls = []

    def fake_turn(store, sid, prompt, **kw):
        calls.append(prompt)
        return {"status": "budget_exhausted" if len(calls) < 3 else "done"}

    monkeypatch.setattr(turn, "run_turn", fake_turn)
    out = turn.run_task(None, "s1", "big job", max_leases=5)
    assert [o["status"] for o in out] == ["budget_exhausted", "budget_exhausted", "done"]
    assert calls == ["big job", turn.CONTINUE_PROMPT, turn.CONTINUE_PROMPT]
