"""Per-agent session discovery + transcript normalisation.

Codex and Pi store per-project JSONL, but with their own line schemas. To reuse
the frontend's Claude parser unchanged, we normalise each agent's lines into the
Claude line shape on the backend (see web/src/lib/parser.ts for the target):

  user      -> {"type":"user","uuid","timestamp","message":{"content": <str|blocks>}}
  assistant -> {"type":"assistant","uuid","timestamp",
                "message":{"content":[{type:text}|{type:tool_use}], "model","usage"}}
  tool res  -> user message whose content is [{type:"tool_result","tool_use_id","content"}]

Discovery scans each agent's sessions root and pulls a cwd + a title snippet.
Everything here is local-only for now (Codex/Pi over SSH is a later step).
"""
import hashlib
import json
import os
from pathlib import Path

from viewer.agents import get_agent


def _root(agent_id):
    return Path(os.path.expanduser(get_agent(agent_id)["sessions"])).resolve()


def resolve_agent_session(agent_id, rel_path):
    """Resolve a session rel-path under the agent's sessions root (guarded)."""
    root = _root(agent_id)
    try:
        full = (root / rel_path).resolve()
    except Exception:
        return None
    # Confine to root by PATH COMPONENTS, not string prefix: a str.startswith
    # check treats "/root-evil/..." as inside "/root", allowing a sibling-dir
    # escape. Comparing components (is_relative_to) closes that traversal.
    if not (full == root or root in full.parents) or not full.is_file():
        return None
    return full


def _uuid(raw):
    return hashlib.md5(raw.encode("utf-8", "replace")).hexdigest()[:20]


def _blocks_text(content, *types):
    """Join the text of Anthropic/OpenAI-style content blocks of given types."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            b.get("text", "") for b in content
            if isinstance(b, dict) and b.get("type") in types and b.get("text")
        )
    return ""


# ---- Codex (~/.codex/sessions/**/rollout-*.jsonl) --------------------------
_CODEX_META_PREFIXES = ("<environment_context>", "<user_instructions>", "<permissions")


def _codex_line(d, raw):
    if d.get("type") != "response_item":
        return None
    p = d.get("payload") or {}
    pt = p.get("type")
    ts, u = d.get("timestamp"), _uuid(raw)
    if pt == "message":
        role = p.get("role")
        text = _blocks_text(p.get("content"), "input_text", "output_text", "text")
        if role == "developer" or not text.strip():
            return None
        if role == "user":
            if text.lstrip().startswith(_CODEX_META_PREFIXES):
                return None
            return json.dumps({"type": "user", "uuid": u, "timestamp": ts,
                               "message": {"content": text}})
        if role == "assistant":
            return json.dumps({"type": "assistant", "uuid": u, "timestamp": ts,
                               "message": {"content": [{"type": "text", "text": text}], "model": "codex"}})
    elif pt == "function_call":
        try:
            args = json.loads(p.get("arguments") or "{}")
        except Exception:
            args = {"arguments": p.get("arguments")}
        return json.dumps({"type": "assistant", "uuid": u, "timestamp": ts,
                           "message": {"content": [{"type": "tool_use", "id": p.get("call_id") or u,
                                                    "name": p.get("name") or "tool", "input": args}],
                                       "model": "codex"}})
    elif pt == "function_call_output":
        out = p.get("output")
        if isinstance(out, dict):
            out = out.get("output") or json.dumps(out)
        return json.dumps({"type": "user", "uuid": u, "timestamp": ts,
                           "message": {"content": [{"type": "tool_result",
                                                    "tool_use_id": p.get("call_id") or u,
                                                    "content": str(out or "")}]}})
    return None


# ---- Pi (~/.pi/agent/sessions/<cwd>/*.jsonl) -------------------------------
def _pi_usage(u):
    if not isinstance(u, dict):
        return None
    return {"input_tokens": u.get("input") or u.get("inputTokens") or 0,
            "output_tokens": u.get("output") or u.get("outputTokens") or 0}


def _pi_line(d, raw):
    if d.get("type") != "message":
        return None
    m = d.get("message") or {}
    role = m.get("role")
    ts = d.get("timestamp") or m.get("timestamp")
    u = d.get("id") or _uuid(raw)
    if role == "user":
        content = m.get("content")
        if isinstance(content, list):
            content = [b for b in content if isinstance(b, dict) and b.get("type") == "text"]
        return json.dumps({"type": "user", "uuid": u, "timestamp": ts, "message": {"content": content}})
    if role == "assistant":
        blocks = []
        for b in (m.get("content") or []):
            if not isinstance(b, dict):
                continue
            if b.get("type") == "text" and b.get("text"):
                blocks.append({"type": "text", "text": b["text"]})
            elif b.get("type") == "toolCall":
                blocks.append({"type": "tool_use", "id": b.get("id"),
                               "name": b.get("name"), "input": b.get("arguments")})
        if not blocks:
            return None
        return json.dumps({"type": "assistant", "uuid": u, "timestamp": ts,
                           "message": {"content": blocks, "model": m.get("model") or "pi",
                                       "usage": _pi_usage(m.get("usage")), "stop_reason": m.get("stopReason")}})
    if role == "toolResult":
        return json.dumps({"type": "user", "uuid": u, "timestamp": ts,
                           "message": {"content": [{"type": "tool_result",
                                                    "tool_use_id": m.get("toolCallId"),
                                                    "content": _blocks_text(m.get("content"), "text")}]}})
    return None


# ---- Copilot CLI (~/.copilot/session-state/<id>/events.jsonl) --------------
# Each line is {type, id, parentId, timestamp, data}. Transcript-bearing types:
# user.message / assistant.message / tool.execution_start / tool.execution_complete.
def _copilot_line(d, raw):
    t = d.get("type")
    data = d.get("data") or {}
    ts, u = d.get("timestamp"), d.get("id") or _uuid(raw)
    if t == "user.message":
        text = data.get("content")
        if not text:
            return None
        return json.dumps({"type": "user", "uuid": u, "timestamp": ts, "message": {"content": text}})
    if t == "assistant.message":
        blocks = []
        if data.get("reasoningText"):
            blocks.append({"type": "thinking", "thinking": data["reasoningText"]})
        if data.get("content"):
            blocks.append({"type": "text", "text": data["content"]})
        if not blocks:
            return None
        return json.dumps({"type": "assistant", "uuid": u, "timestamp": ts,
                           "message": {"content": blocks, "model": data.get("model") or "copilot",
                                       "usage": {"input_tokens": 0, "output_tokens": data.get("outputTokens") or 0}}})
    if t == "tool.execution_start":
        return json.dumps({"type": "assistant", "uuid": u, "timestamp": ts,
                           "message": {"content": [{"type": "tool_use", "id": data.get("toolCallId") or u,
                                                    "name": data.get("toolName") or "tool",
                                                    "input": data.get("arguments") or {}}],
                                       "model": data.get("model") or "copilot"}})
    if t == "tool.execution_complete":
        res = data.get("result") or {}
        content = res.get("content") if isinstance(res, dict) else res
        return json.dumps({"type": "user", "uuid": u, "timestamp": ts,
                           "message": {"content": [{"type": "tool_result",
                                                    "tool_use_id": data.get("toolCallId") or u,
                                                    "content": str(content or "")}]}})
    return None


_NORMALISERS = {"codex": _codex_line, "pi": _pi_line, "copilot": _copilot_line}


def normalize_lines(agent_id, lines):
    """Map raw agent JSONL strings -> Claude-schema strings (dropping skips)."""
    fn = _NORMALISERS.get(agent_id)
    if not fn:
        return lines  # claude / unknown: pass through
    out = []
    for raw in lines:
        try:
            d = json.loads(raw)
        except Exception:
            continue
        n = fn(d, raw)
        if n is not None:
            out.append(n)
    return out


# ---- discovery -------------------------------------------------------------
def _peek(agent_id, f):
    """(cwd, title) from the head of a session file — best effort."""
    cwd, title = "", ""
    try:
        with open(f, errors="replace") as fh:
            for i, line in enumerate(fh):
                if i > 80 or (cwd and title):
                    break
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                if agent_id == "codex":
                    if d.get("type") == "session_meta":
                        cwd = (d.get("payload") or {}).get("cwd") or cwd
                    p = d.get("payload") or {}
                    if not title and p.get("type") == "user_message" and p.get("message"):
                        title = str(p["message"])
                    if not title and p.get("type") == "message" and p.get("role") == "user":
                        t = _blocks_text(p.get("content"), "input_text", "text")
                        if t and not t.lstrip().startswith(_CODEX_META_PREFIXES):
                            title = t
                elif agent_id == "pi":
                    if d.get("type") == "session":
                        cwd = d.get("cwd") or cwd
                    if not title and d.get("type") == "message":
                        m = d.get("message") or {}
                        if m.get("role") == "user":
                            title = _blocks_text(m.get("content"), "text")
                elif agent_id == "copilot":
                    if d.get("type") == "session.start":
                        cwd = ((d.get("data") or {}).get("context") or {}).get("cwd") or cwd
                    if not title and d.get("type") == "user.message":
                        title = (d.get("data") or {}).get("content") or ""
    except Exception:
        pass
    return cwd, " ".join(title.split())[:80]


def list_sessions_local(agent_id):
    root = _root(agent_id)
    if not root.is_dir():
        return []
    out = []
    for f in root.rglob("*.jsonl"):
        # Copilot stores one session per <id>/ dir; only events.jsonl is the
        # transcript and the session id is the DIR name, not the file stem.
        if agent_id == "copilot" and f.name != "events.jsonl":
            continue
        try:
            st = f.stat()
        except OSError:
            continue
        cwd, title = _peek(agent_id, f)
        sid = f.parent.name if agent_id == "copilot" else f.stem
        out.append({"id": sid, "path": str(f.relative_to(root)),
                    "title": title or sid[:8], "project": cwd or str(f.parent.name),
                    "size": st.st_size, "modified": st.st_mtime})
    out.sort(key=lambda s: s["modified"], reverse=True)
    return out
