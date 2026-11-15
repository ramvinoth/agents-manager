"""Where a Claude run executes: this machine, an SSH host, or a throwaway sandbox.

The runner (runtime.runners.claude) builds one command line and drives one
stream-json process the same way wherever it runs. What differs per place is
small and lives behind one interface: which binary, where the MCP config and
settings file live, which plugin folders exist there, how the process starts,
and what has to happen after it exits. Each run gets a fresh backend object, so
a backend may keep per-run state (a temp file, a container) on itself.
"""
from orchestrator import db

# The places a local session may choose to run (session meta "runtime" and the
# server's default_runtime setting). A remote host is chosen by the host itself.
RUNTIMES = ("local", "sandbox")


class Backend:
    """One place a run executes. Subclasses fill in every method."""
    name = ""
    # The run's transcript lives on this machine and is trimmed after each
    # compaction, with the dropped rows archived (orchestrator.history).
    keeps_history = False
    # A probe from this machine says something true about the run's route to a
    # custom endpoint, so the runner may watch that endpoint's health.
    watches_endpoint = False

    def binary(self):
        """argv[0] for claude where the run executes."""
        raise NotImplementedError

    def mcp_config(self):
        """The --mcp-config path that registers the viewer's own MCP servers."""
        raise NotImplementedError

    def settings_arg(self, run_settings):
        """argv that hands the run its --settings JSON."""
        raise NotImplementedError

    def plugin_args(self, session_id, meta):
        """argv for every --plugin-dir the run gets."""
        raise NotImplementedError

    def system_note(self):
        """A line for the system prompt about where the run is, or ''."""
        return ""

    def prepare(self):
        """Anything that must be running before claude boots."""

    def spawn(self, cmd, cwd, env, session_id, forward=()):
        """Start the process; returns a Popen-like object (stdin, stdout, stderr,
        poll, wait, returncode, send_signal, terminate, kill). `forward` names
        the env keys the runner set on purpose for this run (provider and host
        env), which a backend that filters env must carry through."""
        raise NotImplementedError

    def finish(self, session_id):
        """After the process exits. Must never raise."""


def effective_runtime(meta):
    """Where a local session's turns run: its own "runtime" choice, else the
    server's default_runtime setting ("local" unless a SaaS deployment sets
    "sandbox"). An unknown value reads as local, the safe place."""
    runtime = (meta or {}).get("runtime") or db.setting_get("default_runtime", "local")
    return runtime if runtime in RUNTIMES else "local"


def backend_for(host, meta):
    """The backend for one run. A remote host is always SSH; a local session
    runs where effective_runtime says."""
    if host and host != "local":
        from orchestrator.runtime.backends.ssh import SshBackend
        return SshBackend(host)
    if effective_runtime(meta) == "sandbox":
        from orchestrator.runtime.backends.sandbox import SandboxBackend
        return SandboxBackend()
    from orchestrator.runtime.backends.local import LocalBackend
    return LocalBackend()
