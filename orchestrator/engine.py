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
    loop_scheduler,
    run_loop_iteration,
)
from orchestrator.runtime.plugins import (  # noqa: F401
    frontmatter_description,
    plugin_description,
    plugin_mcp_servers,
    scan_command_dir,
    scan_skill_dir,
)
from orchestrator.runtime.process import (  # noqa: F401
    iter_stdout_until,
)
from orchestrator.runtime.run_config import (  # noqa: F401
    resolve_level,
    run_settings_paths_in_use,
    run_settings_sweep_orphans,
    validate_session_credential,
)
from orchestrator.runtime.permissions import (  # noqa: F401
    answer_live_question,
    decide_permission,
    decide_plan,
    pending_approvals_all_public,
    pending_approvals_public,
    register_permission,
)
from orchestrator.runtime.chat import (  # noqa: F401
    end_oneshot_inflight,
    enqueue_chat,
    interrupt_chat,
    record_inflight,
    steer_chat,
)
from orchestrator.runtime.summaries import (  # noqa: F401
    extract_cwd,
)
from orchestrator.runtime.hosts import (  # noqa: F401
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
