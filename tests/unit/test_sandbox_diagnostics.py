"""Hermetic coverage for the opt-in Cloudflare sandbox diagnostics boundary."""
import os
import stat
from pathlib import Path
from unittest.mock import Mock

from orchestrator.runtime.backends import sandbox, sandbox_store
from orchestrator.runtime.backends.sandbox import SandboxBackend, _Box
from orchestrator.runtime.backends.sandbox_drivers import CloudflareDriver, DockerDriver


class _Driver:
    def __init__(self):
        self.run = Mock(return_value=type("Result", (), {"returncode": 0})())
        self.popen = Mock()


def test_diagnostic_paths_are_private_and_not_in_workspace(monkeypatch, tmp_path):
    monkeypatch.setattr(sandbox, "DIAGNOSTICS_ROOT", tmp_path / "diagnostics")
    backend = SandboxBackend(DockerDriver())

    paths = backend.diagnostic_paths("session-id", "opaque-run-id")

    root = tmp_path / "diagnostics" / "session-id" / "opaque-run-id"
    assert paths["local_dir"] == str(root)
    assert paths["debug_file"] == "/opt/harman/diagnostics/claude.debug.log"
    assert stat.S_IMODE(root.stat().st_mode) == 0o700
    for path in (paths["runner_file"], paths["transport_file"]):
        assert Path(path).exists()
        assert stat.S_IMODE(os.stat(path).st_mode) == 0o600


def test_diagnostic_plan_is_separate_from_workspace(monkeypatch, tmp_path):
    monkeypatch.setattr(sandbox, "transcript_path", lambda _: None)
    monkeypatch.setattr(sandbox, "DIAGNOSTICS_ROOT", tmp_path / "diagnostics")
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    backend = SandboxBackend(DockerDriver(), sandbox_store.STORES["viewer"])
    paths = backend.diagnostic_paths("session-id", "opaque-run-id")

    plan = backend._plan("session-id", str(workspace))

    assert plan["workspace"]["local"] == str(workspace)
    assert plan["diagnostics"] == {
        "local": paths["local_dir"],
        "box": "/opt/harman/diagnostics",
    }
    assert not paths["local_dir"].startswith(str(workspace))


def test_diagnostics_fetch_failure_does_not_skip_other_sync_steps(monkeypatch):
    box = _Box(_Driver(), "box", {
        "transcript": {"local": "/tmp/a.jsonl", "box": "/box/a.jsonl"},
        "workspace": None,
        "memory": None,
        "diagnostics": {"local": "/private/diagnostics", "box": "/box/diagnostics"},
    })
    steps = []
    monkeypatch.setattr(box, "_transcript_home", lambda _: steps.append("transcript"))
    monkeypatch.setattr(box, "_sidecar_home", lambda _: steps.append("sidecar"))
    monkeypatch.setattr(box, "_diagnostics_home", Mock(side_effect=RuntimeError("fetch failed")))
    monkeypatch.setattr(box, "sync_folder", lambda key: steps.append(key))

    box.bring_home()

    assert steps == ["transcript", "sidecar", "workspace", "memory"]


def test_cloudflare_exec_only_receives_precreated_diagnostic_path(tmp_path, monkeypatch):
    cfg = tmp_path / "cf.json"
    cfg.write_text('{"url":"https://box.example.dev","secret":"s","node":"node"}')
    monkeypatch.setenv("HARMAN_SANDBOX_CF_CONFIG", str(cfg))
    driver = CloudflareDriver()
    captured = {}

    def popen(args, env, **kwargs):
        captured["args"] = args
        captured["env"] = env
        return object()

    monkeypatch.setattr(sandbox.subprocess, "Popen", popen)
    driver.diagnostic_event_path = str(tmp_path / "box-client.jsonl")

    driver._client("exec", "box", {"argv": ["claude"]})
    assert captured["env"]["HARMAN_BOX_DIAGNOSTICS"] == driver.diagnostic_event_path
    driver._client("reach", "box", {"targets": {}})
    assert "HARMAN_BOX_DIAGNOSTICS" not in captured["env"]


def test_box_client_diagnostic_events_are_payload_free():
    source = (Path(sandbox.__file__).with_name("box_client.mjs")).read_text()
    start = source.index("function event(")
    event_body = source[start:source.index("\n}\n\nfunction die", start)]

    for forbidden in ("spec", "secret", "auth", "payload", "headers", "process.env"):
        assert forbidden not in event_body
    for required in ("event: type", "monotonic_ns", "wall_ms"):
        assert required in event_body
