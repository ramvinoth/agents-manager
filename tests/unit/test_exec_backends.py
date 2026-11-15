"""Unit tests for runtime.backends: which backend a run gets, and the pure
parts of the sandbox backend (paths, URL rewriting, the env a box gets)."""
import pytest

from orchestrator.runtime import backends
from orchestrator.runtime.backends import sandbox
from orchestrator.runtime.backends.local import LocalBackend
from orchestrator.runtime.backends.sandbox import SandboxBackend
from orchestrator.runtime.backends.sandbox_drivers import CloudflareDriver, DockerDriver
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
        # docker here reaches this machine's private network itself
        ("http://100.100.1.2:4000/v1", "http://100.100.1.2:4000/v1"),
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
        env = SandboxBackend(DockerDriver())._box_env(self._env(FORWARDED="f"), {"FORWARDED"})
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
            SandboxBackend(DockerDriver())._box_env(env, set())

    def test_provider_key_in_settings_counts_as_credential(self, monkeypatch):
        monkeypatch.setattr(sandbox, "_git_config", lambda key: "")
        monkeypatch.setattr(sandbox.project_plugins, "available", lambda: [])
        backend = SandboxBackend(DockerDriver())
        backend.settings_arg({"env": {"ANTHROPIC_AUTH_TOKEN": "byok"}})
        env = self._env()
        del env["CLAUDE_CODE_OAUTH_TOKEN"]
        assert "HOME" in backend._box_env(env, set())

    def test_paths_point_inside_the_box(self, monkeypatch):
        monkeypatch.setattr(sandbox, "session_plugin_dirs", lambda sid, meta: ["/a"])
        monkeypatch.setattr(sandbox.project_plugins, "box_plugin_dirs", lambda: [])
        backend = SandboxBackend(DockerDriver())
        assert backend.binary() == "claude"
        assert backend.mcp_config().startswith(sandbox.OPT)
        assert backend.plugin_args("s", {}) == ["--plugin-dir", f"{sandbox.OPT}/plugins/0"]
        assert not backend.keeps_history and not backend.watches_endpoint


def test_mcp_session_create_offers_exactly_the_runtimes():
    # viewer_mcp runs standalone (also inside a box), so it cannot import RUNTIMES.
    from orchestrator import viewer_mcp
    tool = next(t for t in viewer_mcp._TOOL_LIST if t["name"] == "session_create")
    assert tuple(tool["inputSchema"]["properties"]["runtime"]["enum"]) == backends.RUNTIMES


class TestCloudflareDriver:
    @pytest.fixture
    def driver(self, tmp_path, monkeypatch):
        cfg = tmp_path / "cf.json"
        cfg.write_text('{"url": "https://box.example.dev/", "secret": "s", "node": "/opt/node/bin/node"}')
        monkeypatch.setenv("HARMAN_SANDBOX_CF_CONFIG", str(cfg))
        return CloudflareDriver()

    def test_reads_its_config(self, driver):
        assert driver.url == "https://box.example.dev" and driver.node == "/opt/node/bin/node"

    def test_missing_config_says_so(self, tmp_path, monkeypatch):
        monkeypatch.setenv("HARMAN_SANDBOX_CF_CONFIG", str(tmp_path / "none.json"))
        with pytest.raises(RuntimeError, match="not set up"):
            CloudflareDriver()

    def test_every_routed_origin_joins_the_tunnel(self, driver, monkeypatch):
        monkeypatch.setattr(sandbox, "_git_config", lambda key: "")
        sift = type("P", (), {"mcp_env": ("SIFT_URL",)})()
        monkeypatch.setattr(sandbox.project_plugins, "available", lambda: [sift])
        env = SandboxBackend(driver)._box_env(
            TestSandboxPure._env(None, ANTHROPIC_BASE_URL="https://100.100.1.2:4000"), set())
        aliases = {o: a for a, o in driver.targets.items()}
        assert env["SIFT_URL"] == f"http://{aliases['http://127.0.0.1:8120']}.harman.internal"
        assert env["ANTHROPIC_BASE_URL"] == f"http://{aliases['https://100.100.1.2:4000']}.harman.internal"
        assert env["VIEWER_PERM_BASE"] == f"http://{aliases[f'http://127.0.0.1:{sandbox.PORT}']}.harman.internal"
        assert len(driver.targets) == 3

    @pytest.mark.parametrize("url,origin", [
        ("http://localhost:8091/x", "http://localhost:8091"),
        ("https://10.0.0.5/v1", "https://10.0.0.5:443"),
        ("http://[::1]:9000", "http://[::1]:9000"),
        ("http://gpu.tail1234.ts.net:4000", "http://gpu.tail1234.ts.net:4000"),
        ("http://printer.local", "http://printer.local:80"),
    ])
    def test_routes_what_only_this_machine_reaches(self, driver, url, origin):
        routed = sandbox.reach(url, driver.route)
        assert routed.startswith("http://t0.harman.internal")
        assert driver.targets == {"t0": origin}

    def test_public_hosts_go_direct(self, driver):
        for url in ("https://api.anthropic.com/v1", "http://8.8.8.8:53", "https://inference.example.com"):
            assert sandbox.reach(url, driver.route) == url
        assert driver.targets == {}

    def test_one_alias_per_origin(self, driver):
        a = sandbox.reach("http://127.0.0.1:8120/a", driver.route)
        b = sandbox.reach("http://127.0.0.1:8120/b?q=1", driver.route)
        assert (a, b) == ("http://t0.harman.internal/a", "http://t0.harman.internal/b?q=1")

    def test_users_map_to_box_ids(self, driver):
        assert driver._spec(["id"], "root")["user"] == "0:0"
        assert driver._spec(["id"], None)["user"] == "1000:1000"


def test_unknown_provider_reads_as_docker(monkeypatch):
    from orchestrator.runtime.backends import sandbox_drivers
    monkeypatch.setattr(sandbox_drivers.db, "setting_get", lambda key, default=None: "mars")
    assert isinstance(sandbox_drivers.open_driver(), DockerDriver)
