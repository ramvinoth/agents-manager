"""viewer.toml is the ONE TOML seam (Codex config read/write). It must import
on every interpreter the server runs under — the LaunchAgent uses the system
python 3.9, where stdlib tomllib does not exist. Before this shim, every
codex path (`/api/capabilities?agent=codex`, session_detail for a Codex
session, MCP save) raised ModuleNotFoundError in production."""
from pathlib import Path

from viewer import codex, toml


def test_round_trip_preserves_nested_tables():
    data = {"mcp_servers": {"playwright": {"command": "npx", "args": ["-y", "@playwright/mcp"]}}}
    assert toml.loads(toml.dumps(data)) == data


def test_codex_capabilities_reads_config_without_stdlib_tomllib(tmp_path, monkeypatch):
    cfg = tmp_path / "config.toml"
    cfg.write_text('[mcp_servers.viewer]\ncommand = "python3"\nargs = ["viewer_mcp.py"]\n')
    monkeypatch.setattr(codex, "CODEX_CONFIG", cfg)
    monkeypatch.setattr(codex, "CODEX_SKILLS", tmp_path / "no-skills")
    caps = codex.codex_capabilities("")
    assert [m["name"] for m in caps["mcp"]] == ["viewer"]
    assert caps["mcp"][0]["target"] == "python3 viewer_mcp.py"


def test_codex_mcp_save_writes_toml_and_backs_up(tmp_path, monkeypatch):
    cfg = tmp_path / "config.toml"
    cfg.write_text('[mcp_servers.old]\ncommand = "x"\n')
    monkeypatch.setattr(codex, "CODEX_CONFIG", cfg)
    assert codex.codex_mcp_save("new", {"command": "y"}) == {"saved": True}
    assert set(toml.loads(cfg.read_text())["mcp_servers"]) == {"old", "new"}
    assert Path(str(cfg) + ".bak-viewer").read_text().startswith("[mcp_servers.old]")
    assert codex.codex_mcp_save("old", None, delete=True) == {"deleted": True}
    assert list(toml.loads(cfg.read_text())["mcp_servers"]) == ["new"]
