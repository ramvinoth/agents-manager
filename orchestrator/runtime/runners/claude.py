"""The Claude Code agent runner."""
import collections
import json
import os
import re
import secrets
import threading
import time
import traceback

from orchestrator import db, history, inference_health, procctl, resume
from orchestrator.agents import agent_env
from orchestrator.config import (
    CHAT_IDLE_TIMEOUT,
    CHAT_JOBS,
    CHAT_LOCK,
    PORT,
    VIEWER_TOKEN_FILE,
    claude_version_gate,
    invalidate_claude_bin_cache,
)
from orchestrator.login import auth_status
from orchestrator.runtime.backends import backend_for
from orchestrator.runtime.chat import _resume_cut_turn, _watch_endpoint, feed_next_queued, record_inflight
from orchestrator.runtime.permissions import effective_permission_mode
from orchestrator.runtime.process import iter_stdout_until, stream_user_message
from orchestrator.runtime.run_config import (
    _integrations_summary,
    _run_settings,
    owner_time_line,
    resolve_level,
)
from orchestrator.runtime.titles import push_label

# MCP connect timeout (ms) handed to every driven claude. Claude's default is too
# short when --resume first parses a multi-GB transcript; our own stdio servers
# answer in well under a second, so this only ever waits on a blocked loader.
MCP_CONNECT_TIMEOUT_MS = "120000"


def _fail_note(err, last_lines, tail=5, cap=4000):
    """The persisted failure note for a dead run: the error plus the last few
    stream lines. A run has no per-run log, and its transcript is trimmed on
    the next resume, so without the tail the only record of what a killed run
    was doing is the one-line log message (2026-11-12: a 30-minute silence
    killed a live run and left nothing to diagnose)."""
    note = f"{type(err).__name__}: {err}"
    lines = list(last_lines)[-tail:]
    if lines:
        note += "\nlast stream lines:\n" + "\n".join(lines)
    return note[-cap:]


def start_claude_run(session_id, session_args, message, mode, cwd, model="", host="local", provider_env=None, effort="", on_done=None):
    """Spawn a headless claude run (stream-json, stdin kept open) and track it
    in CHAT_JOBS. While it runs, messages can be QUEUED (delivered as the next
    turn on the same process) or STEERED (injected mid-turn, like the TUI).
    Where it runs is the backend's call (orchestrator.runtime.backends): this
    machine, an SSH host (host != 'local'), or an ephemeral sandbox.

    provider_env (Agent mode): an optional {ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN,
    ANTHROPIC_MODEL} dict that points the harness at a custom Anthropic-compatible
    endpoint (our llama-server). None = the normal Anthropic-cloud Claude run,
    byte-identical to before.

    on_done(rc, detail): optional callback fired once when the run thread finishes
    (used by the loop scheduler to record the outcome to job-run history). Not
    called when the run never starts because a job is already running — the caller
    sees the False return and records that itself.
    Returns False if the session already has a running job."""
    mode = effective_permission_mode(session_id, mode)
    with CHAT_LOCK:
        job = CHAT_JOBS.get(session_id)
        if job and job["running"]:
            return False
        job = {"running": True, "returncode": None, "stderr": "", "stdout": "",
               "started": time.time(), "message": message,
               "queue": [], "proc": None, "turns": 0, "steered": 0,
               "stdin_open": False, "mode": mode, "model": model, "cwd": cwd,
               "interrupted": False, "host": host,
               "provider_env": dict(provider_env) if provider_env else None, "effort": effort,
               "pending_approvals": [], "perm_token": "", "version_gate": "",
               "endpoint_issue": "", "model_wait": inference_health.ModelWait(),
               # Last raw stream lines, for the failure note: the only
               # forensics of what a killed run was doing.
               "last_lines": collections.deque(maxlen=8),
               # The last message sent has had no result yet: a run that ends
               # with this set was cut off mid-turn (resume.was_cut_off).
               "turn_open": True}
        CHAT_JOBS[session_id] = job
    record_inflight(session_id, job)

    meta = db.session_meta_get(session_id) or {}
    backend = backend_for(host, meta)  # where it runs; builds nothing yet
    job["runtime"] = backend.name
    cmd = [backend.binary(), "-p", "--input-format", "stream-json",
           "--output-format", "stream-json", "--verbose"] + session_args
    if mode in ("bypass", "bypassPermissions"):
        cmd.append("--dangerously-skip-permissions")
    elif mode in ("acceptEdits", "plan"):
        cmd += ["--permission-mode", mode]
    elif mode == "default":
        cmd += ["--permission-mode", "default"]
    if effort and effort in ("low", "medium", "high", "xhigh", "max") and not provider_env:
        cmd += ["--effort", effort]
    # Always attach the viewer permission tool. In "default" mode it gates each
    # tool call (Allow/Deny); in every mode it is ALSO how AskUserQuestion reaches
    # the user (the CLI routes AUQ's checkPermissions "ask" to this tool, even under
    # --dangerously-skip-permissions — verified). The backend says where its
    # config lives and how the run reaches back to the viewer.
    perm_token = secrets.token_hex(16)
    job["perm_token"] = perm_token
    # Kanban (org board) tool token: the agent session can create/move cards from
    # inside a turn. Minted per run; the route handler validates it and scopes
    # writes by the session's authority level (see actions.execute).
    kanban_token = secrets.token_hex(16)
    job["kanban_token"] = kanban_token
    # Resolve the authority level this run acts at (override → agent role → ic).
    job["level"] = resolve_level(session_id)
    # Display-name snapshot for the principal the server derives from this run
    # (read back via validate_session_credential, so the auth path is one dict
    # lookup, never a transcript rescan). Same name the chat list and pushes
    # use; a failure here must not block the run from starting.
    try:
        job["label"] = push_label(session_id, cwd)
    except Exception:
        job["label"] = f"Chat {str(session_id)[:8]}"
    # Persist the per-run tokens so they survive a server restart: CHAT_JOBS is
    # in-memory, but the durable pending question/plan (and a still-running MCP
    # subprocess) must stay authorized after a restart. Cleared when the job is
    # reaped. Best-effort — a DB hiccup must not block the run from starting.
    try:
        db.session_token_set(session_id, perm_token, kanban_token,
                             job["level"], cwd, host)
    except Exception:
        pass
    cmd += ["--mcp-config", backend.mcp_config(),
            "--permission-prompt-tool", "mcp__viewerperm__approve"]
    # "default" is the composer's sentinel for "no --model" (the CLI picks). Some
    # clients persist it as a literal, which would run `claude --model default`
    # (an invalid model id). Treat it — and blank — as "omit --model".
    if model and model != "default" and len(model) <= 256 and not re.search(r"[\s\x00-\x1f\x7f]", model):
        cmd += ["--model", model]

    # Per-run --settings: the viewer's own tool allowlist, plus the provider env in
    # Agent mode. The CLI reads env from ~/.claude/settings.json and that WINS over
    # the subprocess environment — so injecting ANTHROPIC_* into env alone is
    # silently overridden by any base URL pinned in settings.json (e.g. a LiteLLM
    # proxy). A `--settings` env block DOES take precedence (verified: it forces
    # /v1/messages to the given base URL). How the JSON reaches the CLI (a 0600
    # file, inline, staged in a box) is the backend's call.
    # A custom endpoint driven through this machine's network gets a liveness
    # Watch (below), so the CLI's own blind ceilings are lifted and the Watch
    # decides when the endpoint has actually failed. An SSH host keeps the CLI
    # defaults: a probe from here says nothing about that host's route.
    watch_url = (provider_env or {}).get("ANTHROPIC_BASE_URL", "") if backend.watches_endpoint else ""
    if watch_url:
        provider_env = {**provider_env, **inference_health.WATCHED_ENV}
    run_settings = _run_settings(provider_env, history_hook=backend.keeps_history)
    cmd += backend.settings_arg(run_settings)

    # System prompt = a global Harman system-awareness preamble (so every session
    # knows it is a node in the orchestration system and how its mcp__viewer__*
    # power is gated), then the per-session prompt and goal from the viewer's panel.
    # The preamble lives in settings (db, runtime-editable) — empty string disables it.
    extra = []
    preamble = db.setting_get("system_preamble", "") or ""
    if preamble.strip():
        extra.append(preamble)
    extra.append(owner_time_line())
    summary = _integrations_summary()
    if summary:
        extra.append(summary)
    if meta.get("systemPrompt"):
        extra.append(meta["systemPrompt"])
    if meta.get("goal"):
        extra.append("Active goal (keep working toward this; check it before stopping): " + meta["goal"])
    if backend.system_note():
        extra.append(backend.system_note())
    if extra:
        cmd += ["--append-system-prompt", "\n\n".join(extra)]
    # The chat's plugins (its agent's, any the owner added), its own extras
    # folder, and every project plugin this machine has on (an app sharing the
    # project's folder, e.g. Sift) — skills, MCP, hooks.
    cmd += backend.plugin_args(session_id, meta)

    def run():
        proc = None
        stderr_buf = []
        try:
            env = agent_env()
            # The session's name, for tools that sign their edits with it (a
            # project plugin's MCP server, e.g. Sift's "edited by" line).
            env["HARMAN_SESSION_LABEL"] = job.get("label") or ""
            # CRITICAL: never let the SERVER'S OWN model/provider env leak into the
            # child claude. If the viewer was launched from a shell that exported
            # ANTHROPIC_* or CLAUDE_CODE_MAX_* (e.g. pointing at a LiteLLM proxy),
            # a real OS env var BEATS a --settings file's env block — so an inherited
            # ANTHROPIC_BASE_URL / CLAUDE_CODE_MAX_CONTEXT_TOKENS would silently
            # override the per-session provider settings and reroute the turn to the
            # wrong endpoint / wrong context window. Strip them so the child starts
            # clean: a custom-provider session gets exactly provider_env (below); a
            # Default session gets only what ~/.claude/settings.json specifies.
            for _k in ("ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
                       "ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL",
                       "CLAUDE_CODE_MAX_CONTEXT_TOKENS", "CLAUDE_CODE_MAX_OUTPUT_TOKENS"):
                env.pop(_k, None)
            # Give MCP servers time to connect on a big resume: claude parses the
            # whole transcript on the same event loop that times out MCP connects,
            # so a multi-GB session (measured 2026-11-10: 2.8 GB, ~45 s) marked
            # viewerperm "failed" and every tool call died with "approve not found".
            # An owner-set MCP_TIMEOUT still wins.
            env.setdefault("MCP_TIMEOUT", MCP_CONNECT_TIMEOUT_MS)
            if backend.keeps_history:
                # After each compaction the CLI rewrites the transcript down to
                # what a resume needs, so a long chat resumes in a second instead
                # of re-parsing gigabytes; orchestrator.history keeps the rows it
                # drops for the app (the PreCompact hook in run_settings + the
                # backend's snapshot). Elsewhere there is no archive, so no trim.
                env.setdefault(history.GC_ENV, "1")
            if perm_token:  # let permission_mcp.py reach the viewer + this session
                env["VIEWER_PERM_SESSION"] = session_id
                env["VIEWER_PERM_PORT"] = str(PORT)
                env["VIEWER_PERM_TOKEN"] = perm_token
            if kanban_token:  # let viewer_mcp.py reach the viewer for this session
                env["VIEWER_KANBAN_SESSION"] = session_id
                env["VIEWER_KANBAN_PORT"] = str(PORT)
                env["VIEWER_KANBAN_TOKEN"] = kanban_token
                # Scope the session's kanban tools to its own project's board:
                # find-or-create the org project for this (host, cwd) so the agent
                # only ever sees/edits tasks under the project it's working in.
                try:
                    proj = db.project_ensure(host, cwd, os.path.basename(cwd.rstrip("/")) or cwd)
                    kanban_project = str(proj["id"])
                    env["VIEWER_KANBAN_PROJECT"] = kanban_project
                    # Persist session -> project so read-only consumers (the
                    # board route's ?session= resolution) can find it without
                    # re-deriving the session's cwd. Meta dies with the session.
                    db.session_meta_patch(session_id, {"kanbanProject": kanban_project})
                except Exception:
                    kanban_project = ""
            # Fall back to a setup-token captured by the viewer's login flow
            # when no regular OAuth credentials exist.
            if not env.get("CLAUDE_CODE_OAUTH_TOKEN") and VIEWER_TOKEN_FILE.exists():
                if auth_status().get("method") == "setup-token":
                    try:
                        env["CLAUDE_CODE_OAUTH_TOKEN"] = VIEWER_TOKEN_FILE.read_text().strip()
                    except Exception:
                        pass
            forward = []  # env set on purpose for this run, which a filtering backend keeps
            try:  # per-host env vars (e.g. GH_TOKEN) so git push / gh authenticate
                from orchestrator.hostenv import host_env
                henv = host_env(host)
                env.update(henv)
                forward += list(henv)
            except Exception:
                pass
            # Agent mode: point the harness at a custom Anthropic-compatible endpoint
            # (our llama-server). Applied LAST so it wins over any inherited creds.
            if provider_env:
                env.update({str(k): str(v) for k, v in provider_env.items()})
                forward += [str(k) for k in provider_env]
            backend.prepare()
            proc = backend.spawn(cmd, cwd, env, session_id, forward=forward)
            with CHAT_LOCK:
                job["proc"] = proc
                job["stdin_open"] = True
            # Remote (paramiko) stderr reads as bytes; local (text=True) as str.
            def _drain_stderr():
                data = proc.stderr.read()
                stderr_buf.append(data.decode("utf-8", "replace") if isinstance(data, bytes) else data)
            threading.Thread(target=_drain_stderr, daemon=True).start()
            stream_user_message(proc, message)
            if watch_url:
                threading.Thread(target=_watch_endpoint, args=(job, proc, watch_url,
                                 provider_env.get("ANTHROPIC_MODEL", ""),
                                 provider_env.get("ANTHROPIC_API_KEY", "")), daemon=True).start()

            for line in iter_stdout_until(proc, CHAT_IDLE_TIMEOUT,
                                          paused=lambda: bool(job.get("pending_approvals"))):
                # Kept for the failure note (last 8, bounded): what a killed
                # run was doing, when its own record is already gone.
                job["last_lines"].append(line[:300].rstrip("\n"))
                # Provider verdict "this model needs a newer claude CLI" arrives
                # as an API-error event on the stream. Detect on the raw line
                # (the code + human sentence survive JSON escaping) so it works
                # regardless of the event's exact shape, and record the actionable
                # message once — the finalizer self-heals the cache and surfaces it.
                if not job["version_gate"]:
                    gate = claude_version_gate(line)
                    if gate:
                        job["version_gate"] = gate
                if not job["endpoint_issue"]:
                    job["endpoint_issue"] = inference_health.diagnose(line) or ""
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if watch_url:
                    job["model_wait"].update(ev, time.time())
                if ev.get("type") != "result":
                    continue
                job["turns"] += 1
                job["turn_open"] = False
                # Capture the final assistant text so the push notification can
                # show the actual reply, not a generic "finished" message.
                res_text = ev.get("result") or ev.get("subtype") or ""
                if isinstance(res_text, str) and res_text.strip():
                    job["last_result"] = res_text.strip()
                # Turn finished: feed the next queued message, or shut down.
                if feed_next_queued(session_id, job, proc):
                    if watch_url:
                        job["model_wait"].turn_sent(time.time())
                else:
                    try:
                        proc.stdin.close()
                    except OSError:
                        pass
            proc.wait(timeout=60)
            job["returncode"] = proc.returncode
        except Exception as e:
            job["returncode"] = -1
            # The job is reaped after CHAT_JOB_TTL; without this line the cause
            # of an rc=-1 run is gone for good. The tail of the stream is the
            # only forensics of what the run was doing when it died.
            job["stderr"] = _fail_note(e, job["last_lines"])
            print(f"  ⚠ run {session_id[:8]} failed: {type(e).__name__}: {e}")
            for line in list(job["last_lines"])[-5:]:
                print(f"    | {line}")
            traceback.print_exc()
            if proc:
                procctl.kill(proc)
        finally:
            # Must never raise: the running/queue cleanup below has to run so the
            # session doesn't stay wedged as "busy" after the process exits.
            try:
                backend.finish(session_id)
            except Exception as e:
                print(f"  ⚠ run {session_id[:8]} backend finish failed: {type(e).__name__}: {e}", flush=True)
            try:
                if stderr_buf and stderr_buf[0]:
                    tail = stderr_buf[0]
                    if isinstance(tail, bytes):
                        tail = tail.decode("utf-8", "replace")
                    job["stderr"] = (job["stderr"] + "\n" + tail)[-4000:].strip()
            except Exception:
                pass
            with CHAT_LOCK:
                leftovers = list(job["queue"])
                job["queue"] = []
                job["proc"] = None
                job["stdin_open"] = False
                job["running"] = False
                job["finished"] = time.time()
                rc = job.get("returncode")
                interrupted = job.get("interrupted")
                last_result = job.get("last_result", "")
                version_gate = job.get("version_gate", "")
                endpoint_issue = job.get("endpoint_issue", "")
                if endpoint_issue:
                    # The clients show the stderr tail as the turn's error: lead
                    # with the explanation, not the CLI's "try again in a moment".
                    job["stderr"] = endpoint_issue
            # A run that died mid-turn (CLI crash, killed, idle timeout) resumes
            # itself, so the owner never has to type "Continue"; one that ended
            # on its own (finished, failed with a reason, interrupted) clears its
            # in-flight row — not for boot to resume. Before the leftovers
            # follow-up below records its own row.
            resumed = False
            try:
                if resume.was_cut_off(job["turn_open"], interrupted,
                                      bool(version_gate or endpoint_issue)):
                    resumed = _resume_cut_turn(session_id, job, leftovers)
                else:
                    db.inflight_run_clear(session_id, job["started"])
            except Exception as e:
                print(f"  ⚠ could not resume cut-off turn {session_id[:8]}: {e}")
            if resumed:
                leftovers = []  # the resumed run carries them; don't also notify
            # Self-heal the stale half of the 2.1.84 incident: the provider
            # rejected this run for a too-old CLI, so force the next run to
            # re-resolve the binary from disk — if the user has since run
            # `claude update`, the retry picks it up immediately (no restart,
            # no hour-long cache wait). Only a local run consults this cache.
            if version_gate and backend.name == "local":
                invalidate_claude_bin_cache()
            # Messages queued in the closing race get a fresh resumed run.
            if leftovers and job["returncode"] == 0:
                first, rest = leftovers[0], leftovers[1:]
                if start_claude_run(session_id, ["--resume", session_id], first,
                                    job["mode"], job["cwd"], job["model"], job.get("host", "local"),
                                    provider_env=job.get("provider_env"), effort=job.get("effort", "")):
                    with CHAT_LOCK:
                        CHAT_JOBS[session_id]["queue"].extend(rest)
                    leftovers = []  # a follow-up run is now carrying them; don't also notify
            # (AskUserQuestion is handled synchronously by the permission tool while
            # the turn is live — see _await_question_answer — so there is nothing to
            # detect here at run-finish.)
            # Background push: tell the app the turn finished (best-effort, async).
            # Skip when a follow-up resumed run is still carrying queued work, and
            # when the user interrupted (they're already looking).
            # A run that hit the resume cap already asked the owner, in the
            # inbox, whether to keep retrying — a second, vaguer push is noise.
            if not leftovers and not interrupted and not resumed and not job.get("owner_told"):
                try:
                    from orchestrator.push import notify_all, push_preview
                    label = push_label(session_id, cwd)
                    phost = job.get("host", "local")
                    if rc == 0 and last_result:
                        body = push_preview(last_result)
                        notify_all(label, body, data={"session": session_id, "host": phost})
                    elif version_gate or endpoint_issue:
                        # Actionable, self-contained: a human reading this on a
                        # phone with no context knows exactly what to do.
                        notify_all(label, version_gate or endpoint_issue,
                                   data={"session": session_id, "host": phost})
                    else:
                        body = "Your agent finished a turn." if rc == 0 else "The run ended with an error."
                        notify_all(label, body, data={"session": session_id, "host": phost})
                except Exception:
                    pass
            # Loop-run history hook: record the outcome exactly once, when this
            # run's process exits. Fired on every finish (independent of the push
            # notification's leftovers/interrupt gating) so a job_runs row is never
            # left dangling "running": this run() thread finalizes once, and a
            # leftovers follow-up is a separate start_claude_run without on_done.
            if on_done:
                try:
                    on_done(rc if rc is not None else -1, job.get("stderr", ""))
                except Exception:
                    pass

    threading.Thread(target=run, daemon=True).start()
    return True
