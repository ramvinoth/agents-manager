"""Unit tests for runtime.backends: which backend a run gets, and the pure
parts of the sandbox backend (paths, URL rewriting, the env a box gets)."""
import pytest

from orchestrator.runtime import backends
from orchestrator.runtime.backends import sandbox
from orchestrator.runtime.backends.local import LocalBackend
from orchestrator.runtime.backends.sandbox import SandboxBackend
from orchestrator.runtime.backends.ssh import SshBackend


@pytest.fixture
def default_runtime(monkeypatch):
    setting = {"value": "local"}
    monkeypatch.setattr(backends.db, "setting_get", lambda key, default=None:
                        setting["value"] if key == "default_runtime" else default)
    return setting


class TestBackendFor:
    def test_remote_host_is_ssh_whatever_the_setting(self, default_runtime):
        default_runtime["value"] = "sandbox"
        assert isinstance(backends.backend_for("box1", {"runtime": "sandbox"}), SshBackend)

    def test_default_is_local(self, default_runtime):
        assert isinstance(backends.backend_for("local", {}), LocalBackend)

    def test_server_default_sandbox(self, default_runtime):
        default_runtime["value"] = "sandbox"
        assert isinstance(backends.backend_for(None, {}), SandboxBackend)

    def test_session_choice_wins_over_server_default(self, default_runtime):
        default_runtime["value"] = "sandbox"
        assert isinstance(backends.backend_for(None, {"runtime": "local"}), LocalBackend)
        default_runtime["value"] = "local"
        assert isinstance(backends.backend_for(None, {"runtime": "sandbox"}), SandboxBackend)

    def test_unknown_runtime_reads_as_local(self, default_runtime):
        default_runtime["value"] = "mars"
        assert backends.effective_runtime({}) == "local"
        assert backends.effective_runtime({"runtime": "moon"}) == "local"


class TestSandboxPure:
    def test_slug_matches_the_cli(self):
        assert sandbox.slug("/Users/u/srv/my.app") == "-Users-u-srv-my-app"

    @pytest.mark.parametrize("url,want", [
        ("http://127.0.0.1:8120/x", "http://host.docker.internal:8120/x"),
        ("http://localhost:4000", "http://host.docker.internal:4000"),
        ("https://inference.example.com/v1", "https://inference.example.com/v1"),
        ("not a url", "not a url"),
    ])
    def test_reach(self, url, want):
        assert sandbox.reach(url) == want

    def _env(self, **extra):
        env = {"PATH": "/usr/bin", "SECRET_OF_HOST": "x", "HOME": "/Users/u",
               "VIEWER_PERM_TOKEN": "p", "VIEWER_KANBAN_TOKEN": "k", "VIEWER_PERM_PORT": "8091",
               "CLAUDE_CODE_OAUTH_TOKEN": "t", "MCP_TIMEOUT": "60000",
               "SIFT_URL": "http://127.0.0.1:8120", "SIFT_SERVICE_TOKEN": "s", "SIFT_EMAIL": "e"}
        env.update(extra)
        return env

    def test_box_env_keeps_only_run_wiring(self, monkeypatch):
        monkeypatch.setattr(sandbox, "_git_config", lambda key: "")
        sift = type("P", (), {"mcp_env": ("SIFT_URL", "SIFT_SERVICE_TOKEN", "SIFT_EMAIL")})()
        monkeypatch.setattr(sandbox.project_plugins, "available", lambda: [sift])
        env = SandboxBackend()._box_env(self._env(FORWARDED="f"), {"FORWARDED"})
        assert "PATH" not in env and "SECRET_OF_HOST" not in env
        assert env["HOME"] == sandbox.HOME
        assert env["FORWARDED"] == "f"
        assert env["SIFT_URL"] == "http://host.docker.internal:8120"
        assert env["VIEWER_PERM_BASE"] == env["VIEWER_KANBAN_BASE"] == f"http://host.docker.internal:{sandbox.PORT}"

    def test_box_env_without_any_credential_refuses(self, monkeypatch):
        monkeypatch.setattr(sandbox, "_git_config", lambda key: "")
        monkeypatch.setattr(sandbox.project_plugins, "available", lambda: [])
        env = self._env()
        del env["CLAUDE_CODE_OAUTH_TOKEN"]
        with pytest.raises(RuntimeError, match="needs a Claude token"):
            SandboxBackend()._box_env(env, set())

    def test_provider_key_in_settings_counts_as_credential(self, monkeypatch):
        monkeypatch.setattr(sandbox, "_git_config", lambda key: "")
        monkeypatch.setattr(sandbox.project_plugins, "available", lambda: [])
        backend = SandboxBackend()
        backend.settings_arg({"env": {"ANTHROPIC_AUTH_TOKEN": "byok"}})
        env = self._env()
        del env["CLAUDE_CODE_OAUTH_TOKEN"]
        assert "HOME" in backend._box_env(env, set())

    def test_paths_point_inside_the_box(self, monkeypatch):
        monkeypatch.setattr(sandbox, "session_plugin_dirs", lambda sid, meta: ["/a"])
        monkeypatch.setattr(sandbox.project_plugins, "box_plugin_dirs", lambda: [])
        backend = SandboxBackend()
        assert backend.binary() == "claude"
        assert backend.mcp_config().startswith(sandbox.OPT)
        assert backend.plugin_args("s", {}) == ["--plugin-dir", f"{sandbox.OPT}/plugins/0"]
        assert not backend.keeps_history and not backend.watches_endpoint


def test_mcp_session_create_offers_exactly_the_runtimes():
    # viewer_mcp runs standalone (also inside a box), so it cannot import RUNTIMES.
    from orchestrator import viewer_mcp
    tool = next(t for t in viewer_mcp._TOOL_LIST if t["name"] == "session_create")
    assert tuple(tool["inputSchema"]["properties"]["runtime"]["enum"]) == backends.RUNTIMES
