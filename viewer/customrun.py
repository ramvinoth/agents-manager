"""Custom-provider chat runner.

When a session opts into a custom OpenAI-compatible provider (its session-meta
carries a "provider" preset id), its turns are proxied here instead of to the
`claude` CLI. We call {baseUrl}/v1/chat/completions ourselves and APPEND
Claude-Code-format JSONL lines to the session transcript, so the entire existing
read / render / status / preview pipeline works unchanged — the app's poll just
picks up the appended lines.

One-shot per turn (like the Pi/Codex runners): no stdin steer/queue. Registers a
CHAT_JOBS entry with the canonical field set so /api/chat/status reports the run
as working/done and the busy guard holds.
"""
import json
import re
import threading
import time
import urllib.error
import urllib.request
import uuid as _uuid
from datetime import datetime, timezone

from viewer.config import CLAUDE_DIR, CHAT_JOBS, CHAT_LOCK, CHAT_TIMEOUT
from viewer import providers

# How many prior transcript records to feed back as context. A small local model
# has a modest window; cap the history we replay.
_HISTORY_LIMIT = 40


def _now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _project_dir_for(cwd):
    """The Claude-Code project directory name for a cwd: the path with every
    '/' replaced by '-' (matches how the CLI encodes it)."""
    return str(cwd).replace("/", "-")


def _resolve_transcript(session_id, cwd):
    """Locate this session's transcript, creating an empty file (with an opening
    cwd record) under the cwd-encoded project dir when it doesn't exist yet."""
    matches = list(CLAUDE_DIR.glob(f"*/{session_id}.jsonl"))
    if matches:
        return matches[0]
    proj = CLAUDE_DIR / _project_dir_for(cwd)
    proj.mkdir(parents=True, exist_ok=True)
    path = proj / f"{session_id}.jsonl"
    # Opening record carries cwd so extract_cwd / resolve / preview all work.
    _append(path, {"type": "mode", "mode": "normal", "sessionId": session_id, "cwd": str(cwd)})
    return path


def _append(path, record):
    with open(path, "a") as fh:
        fh.write(json.dumps(record) + "\n")


def _user_record(session_id, cwd, text):
    return {
        "type": "user",
        "message": {"role": "user", "content": text},
        "uuid": str(_uuid.uuid4()),
        "timestamp": _now_iso(),
        "sessionId": session_id,
        "cwd": str(cwd),
        "userType": "external",
    }


def _assistant_record(session_id, cwd, text, model):
    return {
        "type": "assistant",
        "message": {"role": "assistant", "model": model,
                    "content": [{"type": "text", "text": text}]},
        "uuid": str(_uuid.uuid4()),
        "timestamp": _now_iso(),
        "sessionId": session_id,
        "cwd": str(cwd),
    }


def _history_messages(path):
    """Replay prior visible turns from the transcript as OpenAI messages. Tool
    calls / meta / tool-results are skipped — a plain chat model only needs the
    user/assistant text exchange."""
    msgs = []
    try:
        with open(path, errors="replace") as fh:
            lines = fh.readlines()
    except Exception:
        return msgs
    for line in lines:
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if obj.get("type") not in ("user", "assistant") or obj.get("isMeta"):
            continue
        content = (obj.get("message") or {}).get("content")
        text = ""
        if isinstance(content, str):
            text = content
        elif isinstance(content, list):
            # Skip turns that are only tool_use / tool_result; keep the text blocks.
            parts = [b.get("text", "") for b in content
                     if isinstance(b, dict) and b.get("type") == "text"]
            if any(isinstance(b, dict) and b.get("type") in ("tool_result", "tool_use") for b in content) and not parts:
                continue
            text = "".join(parts)
        text = (text or "").strip()
        if not text:
            continue
        msgs.append({"role": obj["type"], "content": text})
    return msgs[-_HISTORY_LIMIT:]


_AUDIO_TAIL_RE = re.compile(
    # A tab (or newline) followed by a long run of base64-ish chars with no
    # spaces — Step-Audio's TTS parser glues its audio payload onto the text
    # like "the visible reply\t<base64 audio blob>". Real prose never contains
    # a 40+ char unbroken base64 run after a tab, so this is safe to strip.
    r"[\t\n]+[A-Za-z0-9+/=]{40,}\s*$"
)

# Step-Audio also emits inline audio codec tokens like "<audio_3852>" (often a
# run of them prefixed before the visible text). Strip every such token.
_AUDIO_TOKEN_RE = re.compile(r"<audio_\d+>")


def _strip_audio_payload(text):
    """Remove any TTS/audio tokens an audio-first model (Step-Audio) mixes into
    its text content — both the trailing base64 blob and inline <audio_N> codec
    tokens — so the chat window shows clean prose only."""
    if not text:
        return text
    text = _AUDIO_TAIL_RE.sub("", text)
    text = _AUDIO_TOKEN_RE.sub("", text)
    return text.strip()


def _enforce_alternating(messages):
    """Collapse consecutive same-role turns into one. Templates like Gemma's
    require strictly alternating user/assistant messages; merging keeps the
    request valid regardless of transcript shape (e.g. two user turns in a row
    after an error line, or a leading assistant turn)."""
    out = []
    for m in messages:
        if out and out[-1]["role"] == m["role"]:
            out[-1]["content"] += "\n\n" + m["content"]
        else:
            out.append(dict(m))
    # Templates that disallow a leading assistant turn: drop it.
    if out and out[0]["role"] == "assistant":
        out = out[1:]
    return out


def _chat_completion(base_url, api_key, model, messages):
    """POST /v1/chat/completions (non-streaming) and return the reply text.
    Raises on transport / HTTP error so the caller can surface it in-thread."""
    url = base_url.rstrip("/") + "/v1/chat/completions"
    body = json.dumps({"model": model, "messages": messages, "stream": False}).encode()
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    # A non-default User-Agent: some CDNs (Cloudflare) 403 the urllib default.
    req.add_header("User-Agent", "harman-viewer/1.0")
    if api_key:
        req.add_header("Authorization", f"Bearer {api_key}")
    with urllib.request.urlopen(req, timeout=CHAT_TIMEOUT) as resp:
        data = json.loads(resp.read().decode("utf-8", "replace"))
    choices = data.get("choices") or []
    if not choices:
        raise ValueError("Endpoint returned no choices")
    content = (choices[0].get("message") or {}).get("content", "") or ""
    return _strip_audio_payload(content)


def start_custom_run(session_id, preset_id, message, cwd, host="local", mode=""):
    """Proxy one turn through a custom provider, appending user + assistant lines
    to the session transcript. Returns False if the session is already running or
    the preset is missing/invalid."""
    preset = providers.get_preset(preset_id)
    if not preset or not preset.get("baseUrl"):
        return False

    with CHAT_LOCK:
        job = CHAT_JOBS.get(session_id)
        if job and job.get("running"):
            return False
        job = {"running": True, "returncode": None, "stderr": "", "stdout": "",
               "started": time.time(), "message": message, "queue": [], "proc": None,
               "turns": 0, "steered": 0, "stdin_open": False, "mode": mode,
               "model": preset.get("model", ""), "cwd": cwd, "interrupted": False,
               "host": "local", "agent": "custom", "provider": preset_id}
        CHAT_JOBS[session_id] = job

    def run():
        err = ""
        try:
            path = _resolve_transcript(session_id, cwd)
            _append(path, _user_record(session_id, cwd, message))

            # Per-session system prompt / goal. Some chat templates (e.g. Gemma)
            # reject a separate "system" role and require strictly alternating
            # user/assistant turns, so we FOLD the system text into the first user
            # message instead of adding a system message.
            from viewer.engine import SESSION_META
            meta = SESSION_META.get(session_id) or {}
            system = []
            if meta.get("systemPrompt"):
                system.append(meta["systemPrompt"])
            if meta.get("goal"):
                system.append("Active goal (keep working toward this): " + meta["goal"])

            messages = _history_messages(path)  # includes the user line just appended
            if system:
                preamble = "\n\n".join(system)
                first_user = next((m for m in messages if m["role"] == "user"), None)
                if first_user is not None:
                    first_user["content"] = preamble + "\n\n" + first_user["content"]
                else:
                    messages = [{"role": "user", "content": preamble}] + messages

            reply = _chat_completion(preset["baseUrl"], preset.get("apiKey", ""),
                                     preset.get("model", ""), _enforce_alternating(messages))
            _append(path, _assistant_record(session_id, cwd, reply, preset.get("model", "")))
            with CHAT_LOCK:
                job["turns"] += 1
                job["returncode"] = 0
                job["last_result"] = (reply or "").strip()
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode("utf-8", "replace")[:300]
            except Exception:
                pass
            err = f"Endpoint error {e.code}: {detail or e.reason}"
        except Exception as ex:
            err = str(ex)
        finally:
            if err:
                # Surface the failure IN-THREAD so the user sees why nothing came back.
                try:
                    path = _resolve_transcript(session_id, cwd)
                    _append(path, _assistant_record(session_id, cwd,
                                                    f"⚠️ Custom provider error: {err}",
                                                    preset.get("model", "")))
                except Exception:
                    pass
            with CHAT_LOCK:
                if job.get("returncode") is None:
                    job["returncode"] = -1
                job["running"] = False
                job["finished"] = time.time()
                job["stderr"] = err[-2000:]
                rc = job.get("returncode")
                last_result = job.get("last_result", "")
            # Background push, mirroring the claude runner's finish hook.
            try:
                from viewer.push import notify_all, push_preview
                from viewer.engine import _push_label
                label = _push_label(session_id, cwd)
                if rc == 0 and last_result:
                    notify_all(label, push_preview(last_result),
                               data={"session": session_id, "host": host})
                else:
                    notify_all(label, "The run ended with an error." if rc != 0 else "Your agent finished a turn.",
                               data={"session": session_id, "host": host})
            except Exception:
                pass

    threading.Thread(target=run, daemon=True).start()
    return True
