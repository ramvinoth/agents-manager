"""A run on an SSH host: the host's own claude, reaching the viewer over the tailnet."""
import json

from orchestrator.browser import ensure_mcp_browser
from orchestrator.config import PORT
from orchestrator.remote import remote_claude_bin, remote_setup_perm_mcp, viewer_tailnet_base
from orchestrator.runtime.backends import Backend
from orchestrator.runtime.process import RemoteProc

# The env a remote shell needs: paramiko exec inherits nothing, and the rest of
# this machine's env means nothing there.
_REMOTE_ENV = ("MCP_TIMEOUT", "VIEWER_PERM_SESSION", "VIEWER_PERM_TOKEN",
               "VIEWER_KANBAN_SESSION", "VIEWER_KANBAN_TOKEN", "VIEWER_KANBAN_PROJECT")


class SshBackend(Backend):
    name = "ssh"

    def __init__(self, host):
        self.host = host

    def binary(self):
        return "claude"

    def mcp_config(self):
        return remote_setup_perm_mcp(self.host, PORT)

    def settings_arg(self, run_settings):
        # Inline JSON: a local temp path means nothing on the other host, and
        # the remote shell command already carries the per-run tokens.
        return ["--settings", json.dumps(run_settings)]

    def plugin_args(self, session_id, meta):
        return []  # plugin folders live on this machine

    def prepare(self):
        ensure_mcp_browser(self.host)

    def spawn(self, cmd, cwd, env, session_id, forward=()):
        # nvm/npm installs aren't on the non-interactive login PATH.
        try:
            cmd[0] = remote_claude_bin(self.host)
        except Exception:
            pass
        renv = {k: env[k] for k in _REMOTE_ENV if env.get(k)}
        base = viewer_tailnet_base(PORT)
        if base:
            renv["VIEWER_PERM_BASE"] = base
            renv["VIEWER_KANBAN_BASE"] = base
        return RemoteProc(self.host, cmd, cwd, env=renv)
