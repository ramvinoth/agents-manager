"""What a run starts with: permission MCP config, run settings, authority level, system-prompt context."""
import json
import os
import shlex
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

from orchestrator import db, orglogic
from orchestrator.config import CHAT_JOBS, CHAT_LOCK, PORT


# The tool each server must list, or every driven run breaks (maintenance preflight checks it).
REQUIRED_MCP_TOOLS = {"viewerperm": "approve", "viewer": "card_list"}


def perm_mcp_servers():
    """The mcpServers entries every driven claude run loads. The scripts live in the
    package root (orchestrator/), not beside this module in orchestrator/runtime/ —
    resolving them from here once pointed every run at missing files, so every
    permission prompt failed ("mcp__viewerperm__approve not found")."""
    pkg = Path(__file__).resolve().parent.parent
    py = sys.executable or "python3"
    return {"viewerperm": {"command": py, "args": [str(pkg / "permission_mcp.py")]},
            "viewer": {"command": py, "args": [str(pkg / "viewer_mcp.py")]}}


def _write_perm_mcp_config():
    """Write (idempotently) the --mcp-config that registers BOTH viewer MCP servers:
    'viewerperm' (permission_mcp.py) and 'viewer' (viewer_mcp.py). Additive —
    the driven claude still loads the user's ambient MCP servers (Playwright etc.)
    since we omit --strict-mcp-config. Every run sets VIEWER_KANBAN_* env (the token
    is minted unconditionally, see start_claude_run), so viewer_mcp's tools are always
    reachable; the server resolves the caller to at least 'ic' and scopes each write by
    the session's responsibility level — it never fails auth for a run with no role."""
    path = os.path.join(tempfile.gettempdir(), "agents_viewerperm_mcp.json")
    cfg = {"mcpServers": perm_mcp_servers()}
    # One shared file, rewritten by every run start, read by every claude child
    # some time after spawn. An in-place open(path, "w") truncates first, so a
    # child reading during a concurrent start sees "" or a prefix and dies with
    # "Invalid MCP configuration". Write beside it and rename: the swap is
    # atomic, and a reader holding the old inode still gets a complete document.
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".agents_viewerperm_mcp.", suffix=".json")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(cfg, f)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return path


def _run_settings(provider_env=None, history_hook=False):
    """The `--settings` JSON every driven claude run starts with.

    `permissions.allow` pre-approves the viewer's own MCP tools (`mcp__viewer__*`,
    the board/org/loop bridge registered by _write_perm_mcp_config). Without it, a
    run in default/acceptEdits mode routes each viewer tool call through the
    permission-prompt tool like any unknown MCP tool — a gate nobody answers for a
    loop-fired or wake-fired agent, so the call sits for PERM_TIMEOUT and is denied,
    and the agent's board steering silently rots. The server that registers the
    tools is the one place that knows their name, so the allow rule lives here, not
    in any machine's ~/.claude/settings.json (which merges with this, never
    conflicts). The rule does not bypass the viewer's own authority checks: every
    call still carries the per-run token and is scoped server-side by level.

    provider_env (Agent mode) becomes the `env` block that points the harness at a
    custom endpoint; see start_claude_run for why it must travel via --settings.

    history_hook (local runs, which trim their transcript after a compaction)
    adds the PreCompact hook that snapshots the transcript first, so the rows
    the trim drops reach orchestrator.history's archive and stay browsable."""
    settings = {"permissions": {"allow": ["mcp__viewer__*"]}}
    if history_hook:
        script = Path(__file__).resolve().parent.parent / "history.py"
        cmd = f"{shlex.quote(sys.executable)} -I {shlex.quote(str(script))}"
        settings["hooks"] = {"PreCompact": [{"hooks": [{"type": "command", "command": cmd}]}]}
    if provider_env:
        penv = {k: str(v) for k, v in provider_env.items()}
        # Clear any inherited small-fast model so background calls don't leak to
        # a different endpoint's model namespace.
        penv.setdefault("ANTHROPIC_SMALL_FAST_MODEL", penv.get("ANTHROPIC_MODEL", ""))
        settings["env"] = penv
    return settings


RUN_SETTINGS_PREFIX = "viewer-run-"


def run_settings_sweep_orphans(live_paths, tmpdir=None):
    """Boot-time reconciliation for the per-run --settings files.

    start_claude_run unlinks its file in the run thread's `finally`, which never
    executes when the server is SIGKILLed (`launchctl kickstart -k`), so every
    restart leaks one file per in-flight run — each holding the provider's
    ANTHROPIC_* credentials in $TMPDIR. `live_paths` are the files still held open
    on a running child's argv (from `ps`); everything else with our prefix belongs
    to a run that died with the previous process. Returns the paths removed."""
    root = Path(tmpdir or tempfile.gettempdir())
    live = {str(Path(p)) for p in live_paths}
    removed = []
    for path in root.glob(RUN_SETTINGS_PREFIX + "*.json"):
        if str(path) in live:
            continue
        try:
            path.unlink()
            removed.append(str(path))
        except FileNotFoundError:
            pass
    return removed


def run_settings_paths_in_use():
    """Settings paths referenced by any live `--settings` argv on this machine —
    the previous server's children survive a SIGKILL of the parent only when
    launchd does not take the process group, so ps, not our own bookkeeping, is
    the authority on which files are still in use."""
    try:
        out = subprocess.run(["ps", "-axo", "args="], capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return set()
    paths = set()
    for line in out.splitlines():
        for tok in line.split():
            if RUN_SETTINGS_PREFIX in tok and tok.endswith(".json"):
                paths.add(tok)
    return paths


def resolve_level(session_id):
    """The Manager authority level (ic < lead < manager) a session runs at.

    One resolution, in order: the owner's per-chat override (session_meta.level,
    set through the Red session_level_set action), then the level of the agent
    role the chat was started from (Agents tab template), else 'ic' — least
    authority, the safe default. A DB hiccup also lands on 'ic', so a storage
    failure can never raise a session's authority on its own.
    """
    try:
        meta = db.session_meta_get(session_id) or {}
        if meta.get("level") in orglogic.LEVELS:
            return meta["level"]
        tid = meta.get("agentTemplate")
        tpl = db.agent_template_get(tid) if tid else None
        if tpl and tpl.get("level") in orglogic.LEVELS:
            return tpl["level"]
    except Exception:
        pass
    return "ic"


def validate_session_credential(session_id, token):
    """Authenticate an MCP subprocess by its per-run token. Returns
    {'level', 'label'} for the run, or None if unknown/unauthorized
    (the server then 401s before any handler runs). `label` is the display name
    the run started with (start_claude_run's snapshot) — the same name the chat
    list and pushes use — so the server's principal can name an UNLINKED
    session ("session:RSI") instead of a bare id without rescanning the
    transcript on every request.

    Either per-run token authenticates. `perm_token` and `kanban_token` are two
    secrets for ONE principal: both are minted by the same start_claude_run, for
    the same session, and shipped in the same env to the same child process
    (runtime/runners/claude.py, the env block in run()). They are not separate authority scopes — authority is
    the session's level, identical whichever token is presented — so treating
    them as one credential keeps the promise that a caller is resolved exactly
    once, and avoids two near-identical validators drifting apart.

    Falls back to the persisted session_tokens row when CHAT_JOBS has no entry,
    so a durable pending question/plan can still be answered.
    """
    if not session_id or not token:
        return None
    with CHAT_LOCK:
        job = CHAT_JOBS.get(session_id)
        if job:
            if token not in (job.get("kanban_token") or None,
                             job.get("perm_token") or None):
                return None
            return {"level": job.get("level") or "ic",
                    "label": job.get("label") or ""}
    # No live job (restart): validate against the persisted tokens. The label
    # is a per-run snapshot (not persisted), so a run outliving a restart
    # degrades to "" — the caller falls back to the session's short id.
    try:
        row = db.session_token_get(session_id)
        if not row or token not in (row.get("kanban_token") or None,
                                    row.get("perm_token") or None):
            return None
        return {"level": row.get("level") or "ic", "label": ""}
    except Exception:
        return None


def _perm_mcp_config_path(host):
    """--mcp-config path for the viewer permission tool: a local temp file for a
    local run, or a remote path (config + helper shipped over SFTP) for a remote
    host, whose permission_mcp reaches the viewer through an SSH reverse tunnel."""
    if host and host != "local":
        from orchestrator.remote import remote_setup_perm_mcp
        return remote_setup_perm_mcp(host, PORT)
    return _write_perm_mcp_config()


def owner_time_line(now=None, localtime_path="/etc/localtime"):
    """The owner's time zone, said once per run, so an agent writes every time
    it shows them in THEIR zone (this server's) and never in UTC. Zone only, no
    clock: a fixed line keeps the prompt cacheable; `date` gives the time. Pure."""
    now = (now or datetime.now()).astimezone()
    real = os.path.realpath(localtime_path)
    iana = os.environ.get("TZ") or (real.split("zoneinfo/", 1)[1] if "zoneinfo/" in real else "")
    off = now.strftime("%z")
    zone = f"{iana} ({now.tzname()}, UTC{off[:3]}:{off[3:]})" if iana else f"{now.tzname()} (UTC{off[:3]}:{off[3:]})"
    return (f"Time: the owner's time zone is {zone}. Write every time you show the owner "
            f"in it (e.g. 9:16 PM {now.tzname()}), never in UTC. Tool timestamps are UTC/epoch "
            "unless they carry an offset or a *_local twin; convert them. A loop_create `at` "
            "or calendar time without an offset is read in this zone. Run `date` for the time now.")


def _integrations_summary():
    """What this run may use right now (accounts, services, operations, local
    folders), so an agent knows its integrations natively. Built per run from
    the same rules the routes enforce; a failure never blocks the turn."""
    try:
        from orchestrator.integrations import catalog
        return catalog.agent_summary(
            catalog.agent_view(list(db.drives_load().values()), db.local_disk_rules()))
    except Exception as e:
        print(f"[engine] integrations summary failed: {e}", flush=True)
        return ""
