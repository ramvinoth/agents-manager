"""The preflight MCP self-check: the real servers pass, a missing script fails."""
import sys

from orchestrator.runtime import mcp_selfcheck
from orchestrator.runtime.run_config import perm_mcp_servers


def test_real_servers_list_their_required_tools():
    assert mcp_selfcheck.main() == 0


def test_missing_script_is_reported(tmp_path):
    spec = {"command": sys.executable, "args": [str(tmp_path / "gone.py")]}
    assert "no tools/list reply" in mcp_selfcheck.probe("viewerperm", spec)


def test_stdout_noise_is_reported(tmp_path):
    noisy = tmp_path / "noisy.py"
    noisy.write_text("print('hello')\n")
    assert "non-protocol" in mcp_selfcheck.probe("viewer", {"command": sys.executable, "args": [str(noisy)]})


def test_config_registers_both_servers():
    assert set(perm_mcp_servers()) == {"viewer", "viewerperm"}
