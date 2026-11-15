"""A run on this machine: the CLI the owner installed, the plugins in its folders."""
import json
import os
import subprocess
import tempfile
import threading
import time

from orchestrator import history, procctl, project_plugins
from orchestrator.browser import ensure_mcp_browser
from orchestrator.config import claude_bin, session_plugin_dirs, transcript_path
from orchestrator.runtime.backends import Backend
from orchestrator.runtime.run_config import RUN_SETTINGS_PREFIX, _write_perm_mcp_config


def _finish_history(session_id):
    """Fold what this run's trims dropped into the chat's history archive, in a
    thread (a chat's first fold copies its whole old transcript: seconds). Only
    snapshots from before now are settled, so the next run's are left alone."""
    live = transcript_path(session_id)
    if not live:
        return
    cutoff = time.time_ns()

    def fold():
        try:
            history.finish_run(live, before_ns=cutoff)
        except Exception as e:
            print(f"  ⚠ history fold {session_id[:8]} failed: {type(e).__name__}: {e}", flush=True)
    threading.Thread(target=fold, daemon=True, name="history-fold").start()


class LocalBackend(Backend):
    name = "local"
    keeps_history = True
    watches_endpoint = True

    def __init__(self):
        self.settings_path = None

    def binary(self):
        return claude_bin()

    def mcp_config(self):
        return _write_perm_mcp_config()

    def settings_arg(self, run_settings):
        # A 0600 temp file keeps provider secrets out of argv.
        try:
            fd, self.settings_path = tempfile.mkstemp(prefix=RUN_SETTINGS_PREFIX, suffix=".json")
            with os.fdopen(fd, "w") as f:
                json.dump(run_settings, f)
            os.chmod(self.settings_path, 0o600)
            return ["--settings", self.settings_path]
        except Exception as e:
            print(f"[engine] run settings write failed: {e}", flush=True)
            return []

    def plugin_args(self, session_id, meta):
        # The chat's plugins, its extras folder, and every project plugin on
        # this machine (an app sharing the project's folder, e.g. Sift).
        args = []
        for plugin_dir in session_plugin_dirs(session_id, meta) + project_plugins.plugin_dirs():
            args += ["--plugin-dir", str(plugin_dir)]
        return args

    def prepare(self):
        # If Playwright MCP attaches to our CDP browser, it must be up first.
        ensure_mcp_browser("local")

    def spawn(self, cmd, cwd, env, session_id, forward=()):
        live = transcript_path(session_id)
        if live:  # belt to the PreCompact hook's braces
            history.snapshot(live)
        return subprocess.Popen(cmd, cwd=procctl.local_cwd(cwd), env=env, text=True,
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, **procctl.interruptible_kwargs())

    def finish(self, session_id):
        if self.settings_path:
            try:
                os.unlink(self.settings_path)
            except OSError:
                pass
        _finish_history(session_id)
