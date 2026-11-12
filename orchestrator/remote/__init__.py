"""orchestrator.remote — everything the viewer does on an SSH host.

One module per job: transport (the SSH pool and exec helpers), agents (agent CLIs,
sign-in, capabilities), sessions (transcripts on the host), fs (the file browser over
SFTP), tailnet (how a remote chat reaches back to the viewer). This package re-exports
the public names so callers keep importing from orchestrator.remote. To patch one in a
test, patch it in the module that defines it, where its callers look it up.
"""
from orchestrator.remote.transport import SSH, remote_run_python, remote_run_shell  # noqa: F401
from orchestrator.remote.agents import (  # noqa: F401
    remote_agents_status, remote_capabilities, remote_claude_bin, remote_codex_bin,
    remote_codex_logged_in, remote_copilot_bin, remote_copilot_logged_in, remote_install_agent,
    remote_mcp_probe, remote_mcp_save, test_host_config,
)
from orchestrator.remote.sessions import (  # noqa: F401
    remote_agent_full_path, remote_codex_meta, remote_extract_cwd, remote_full_path,
    remote_list_sessions, remote_list_sessions_agent, remote_projects, remote_read_agent_session,
    remote_read_session, remote_resolve, remote_session_edit,
)
from orchestrator.remote.fs import (  # noqa: F401
    _remote_expand, content_disposition, remote_build_zip, remote_compress, remote_delete,
    remote_fs, remote_mkdir, remote_read_bytes, remote_rename, remote_unlink, remote_upload,
)
from orchestrator.remote.tailnet import (  # noqa: F401
    remote_setup_perm_mcp, tailnet_ipv4, tailnet_ipv4_from_text, viewer_tailnet_base,
)
