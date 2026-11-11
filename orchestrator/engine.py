"""orchestrator.engine — facade over orchestrator.runtime.

The agent runtime lives in orchestrator/runtime/: runners/ (one per agent CLI),
chat control, permissions, run config, the loop scheduler, hosts, summaries,
titles and plugin discovery. This module re-exports their public names so
existing callers keep working. Private helpers are deliberately not exported:
patch them where they live (a stale patch here fails loudly)."""
from orchestrator.runtime.titles import (  # noqa: F401
    push_label,
    session_title,
)
from orchestrator.runtime.scheduler import (  # noqa: F401
    CANVAS_TOMBSTONE_TTL,
    CHAT_JOB_TTL,
    SESSION_TOKEN_MAX_AGE,
    fire_due_loops,
    loop_scheduler,
    run_loop_iteration,
)
from orchestrator.runtime.plugins import (  # noqa: F401
    frontmatter_description,
    machine_plugins,
    plugin_description,
    plugin_mcp_servers,
    scan_command_dir,
    scan_skill_dir,
)
from orchestrator.runtime.process import (  # noqa: F401
    RemoteProc,
    iter_stdout_until,
    stream_user_message,
)
from orchestrator.runtime.run_config import (  # noqa: F401
    RUN_SETTINGS_PREFIX,
    owner_time_line,
    resolve_level,
    run_settings_paths_in_use,
    run_settings_sweep_orphans,
    validate_session_credential,
)
from orchestrator.runtime.permissions import (  # noqa: F401
    answer_live_question,
    decide_permission,
    decide_plan,
    effective_permission_mode,
    pending_approvals_all_public,
    pending_approvals_public,
    register_permission,
)
from orchestrator.runtime.chat import (  # noqa: F401
    RESUME_SETTLE,
    end_oneshot_inflight,
    enqueue_chat,
    feed_next_queued,
    interrupt_chat,
    record_inflight,
    steer_chat,
)
from orchestrator.runtime.summaries import (  # noqa: F401
    REMOTE_SUMMARY_CACHE,
    StatCache,
    extract_cwd,
    remote_session_summary,
)
from orchestrator.runtime.hosts import (  # noqa: F401
    Host,
    LOCAL_SUMMARY_CACHE,
    LocalHost,
    RemoteHost,
    get_host,
)
from orchestrator.runtime.runners.claude import (  # noqa: F401
    start_claude_run,
)
from orchestrator.runtime.runners.codex import (  # noqa: F401
    codex_session_meta,
    start_codex_run,
)
from orchestrator.runtime.runners.copilot import (  # noqa: F401
    copilot_session_meta,
    start_copilot_new,
    start_copilot_run,
)
from orchestrator.runtime.runners.pi import (  # noqa: F401
    pi_session_cwd,
    pi_session_provider_model,
    pi_session_uuid,
    start_pi_run,
)
