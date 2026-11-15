"""The failure note a dead run leaves behind.

A run has no per-run log and its transcript is trimmed on the next resume, so
the last few stream lines are the only record of what a killed run was doing.
2026-11-12: a 30-minute silence killed a live run and the log held just one
line with nothing to diagnose.
"""
from collections import deque
from unittest.mock import Mock

from orchestrator.runtime.runners import claude
from orchestrator.runtime.runners.claude import _fail_note


class _Err(Exception):
    pass


def test_fail_note_is_bare_error_when_no_lines():
    assert _fail_note(_Err("No output for 1800s (idle timeout)"), []) == \
        "_Err: No output for 1800s (idle timeout)"


def test_fail_note_appends_the_last_stream_lines():
    note = _fail_note(_Err("boom"), deque(["a", "b", "c"], maxlen=8))
    assert note == "_Err: boom\nlast stream lines:\na\nb\nc"


def test_fail_note_keeps_only_the_tail_lines():
    note = _fail_note(_Err("boom"), deque(["x", "y", "z", "w", "v", "u"], maxlen=8))
    # tail=5 of the last six
    assert note == "_Err: boom\nlast stream lines:\ny\nz\nw\nv\nu"


def test_fail_note_caps_the_note():
    note = _fail_note(_Err("e"), deque(["L" * 300 for _ in range(8)], maxlen=8))
    assert len(note) <= 4000


class _ImmediateThread:
    """Run the runner's background work synchronously for command inspection."""

    def __init__(self, *, target, daemon):
        self.target = target

    def start(self):
        self.target()


class _CompletedProcess:
    def __init__(self):
        self.stdin = Mock()
        self.stderr = Mock()
        self.stderr.read.return_value = ""
        self.returncode = 0

    def wait(self, timeout):
        return self.returncode


def _capture_run_command(monkeypatch, *, meta, backend):
    """Exercise the runner through its spawn boundary without external effects."""
    commands = []
    proc = _CompletedProcess()

    monkeypatch.setattr(claude, "CHAT_JOBS", {})
    monkeypatch.setattr(claude, "effective_permission_mode", lambda *_: "default")
    monkeypatch.setattr(claude, "record_inflight", lambda *_: None)
    monkeypatch.setattr(claude.db, "session_meta_get", lambda _: meta)
    monkeypatch.setattr(claude.db, "session_token_set", lambda *_: None)
    monkeypatch.setattr(claude.db, "setting_get", lambda *_: "")
    monkeypatch.setattr(claude.db, "project_ensure", lambda *_: {"id": 1})
    monkeypatch.setattr(claude.db, "session_meta_patch", lambda *_: None)
    monkeypatch.setattr(claude.db, "inflight_run_clear", lambda *_: None)
    monkeypatch.setattr(claude, "backend_for", lambda *_: backend)
    monkeypatch.setattr(claude, "push_label", lambda *_: "Test")
    monkeypatch.setattr(claude, "_run_settings", lambda *_args, **_kwargs: {})
    monkeypatch.setattr(claude, "owner_time_line", lambda: "")
    monkeypatch.setattr(claude, "_integrations_summary", lambda: "")
    monkeypatch.setattr(claude, "agent_env", lambda: {})
    monkeypatch.setattr(claude, "stream_user_message", lambda *_: None)
    monkeypatch.setattr(claude, "iter_stdout_until", lambda *_args, **_kwargs: iter(()))
    monkeypatch.setattr(claude.resume, "was_cut_off", lambda *_: False)
    monkeypatch.setattr(claude.threading, "Thread", _ImmediateThread)

    def spawn(cmd, *_args, **_kwargs):
        commands.append(cmd)
        return proc

    backend.spawn = spawn
    assert claude.start_claude_run("session", [], "hello", "default", "/workspace")
    return commands


def _backend(name):
    backend = Mock()
    backend.name = name
    backend.keeps_history = False
    backend.watches_endpoint = False
    backend.binary.return_value = "claude"
    backend.mcp_config.return_value = "/private/mcp.json"
    backend.settings_arg.return_value = []
    backend.plugin_args.return_value = []
    backend.system_note.return_value = ""
    return backend


def test_normal_runner_command_never_adds_debug_file(monkeypatch):
    backend = _backend("local")

    commands = _capture_run_command(monkeypatch, meta={"sandboxDiagnostics": True}, backend=backend)

    assert len(commands) == 1
    assert "--debug-file" not in commands[0]
    backend.diagnostic_paths.assert_not_called()


def test_sandbox_diagnostic_command_has_one_server_controlled_debug_path(monkeypatch):
    backend = _backend("sandbox")
    diagnostic = {
        "run_id": "server-run-id",
        "debug_file": "/opt/harman/diagnostics/claude.debug.log",
        "runner_file": "",
    }
    backend.diagnostic_paths.return_value = diagnostic

    commands = _capture_run_command(monkeypatch, meta={"sandboxDiagnostics": True}, backend=backend)

    assert len(commands) == 1
    command = commands[0]
    assert command.count("--debug-file") == 1
    assert command[command.index("--debug-file") + 1] == diagnostic["debug_file"]
    backend.diagnostic_paths.assert_called_once()
