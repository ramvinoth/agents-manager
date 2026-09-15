"""viewer.docs — the read-only documentation surface exposed to agents.

Two kinds of doc, one list:
  - Whitelisted design docs: a fixed set of repo-root markdown files (the charter,
    the MCP/RBAC design, the Kanban design, the secrets/providers designs, the
    README). The whitelist IS the security boundary — read_doc resolves a doc only
    by its registered id, never by a caller-supplied path, so there is no traversal
    surface: an id that is not a key here is simply "not found". A defence-in-depth
    check also confirms the resolved file is a direct child of the repo root.
  - One synthetic "system-status" doc, composed live from the settings store: the
    global system preamble plus the current automation / loop-control posture. It is
    not a file — it is the machine describing its own current state — so it is always
    present and always current.

Pure library: list_docs()/read_doc() compute from STATIC_DIR (repo root) and the
settings store. The route layer (routes.orchestrator) is dumb transport over these.
"""
from viewer import db
from viewer.config import STATIC_DIR

# id (== filename) -> (title, one-line description). The whitelist is the security
# boundary: read_doc only opens STATIC_DIR/<id>, and only when <id> is a key here,
# so a caller can never address a file outside this set.
_FILE_DOCS = {
    "SESSIONS.md": ("Sessions & employees",
                    "What a session is, employee vs normal, and what every session can see."),
    "README.md": ("Harman — overview",
                  "What Harman is and how the pieces fit together."),
    "ORCHESTRATOR.md": ("Company charter",
                        "The operating contract: roles, RBAC, the Green/Red gate."),
    "ORCHESTRATOR_KANBAN.md": ("Kanban / empire design",
                               "The board model and the autonomous manager."),
    "ORCHESTRATOR_MCP.md": ("Internal MCP + layered RBAC",
                            "The agent-facing MCP surface, authority tiers, skill distillation."),
    "PROVIDERS_DESIGN.md": ("Model-provider registry",
                            "Typed LLM/STT/TTS providers, no hardcoded endpoints."),
    "SECRETS_DESIGN.md": ("Encrypted secrets store",
                          "How secrets are held and env-injected."),
}

# The synthetic doc's id. Not a filename — read_doc composes its body from live state.
_STATUS_ID = "system-status"
_STATUS_TITLE = "System status (live)"
_STATUS_DESC = "This machine's current posture: preamble, automation switch, loop mode."


def _doc_path(doc_id):
    """The on-disk path for a whitelisted file doc, or None. Membership in
    _FILE_DOCS is the real gate; the parent-dir check is belt-and-suspenders so a
    future edit that let a slash into a key still cannot escape the repo root."""
    if doc_id not in _FILE_DOCS:
        return None
    p = (STATIC_DIR / doc_id).resolve()
    if p.parent != STATIC_DIR.resolve():
        return None
    return p


def _status_markdown():
    """Compose the live system-status doc from the settings store. Reads the same
    sources the /api/org/system-preamble and /api/org/loop-control routes serve, so
    it never drifts from them."""
    from viewer import orchestrator
    preamble = (db.setting_get("system_preamble", "") or "").strip()
    auto = orchestrator.automation_enabled()
    mode = orchestrator.loop_mode()
    mode_line = {
        "none": "none — no scheduled loops fire (yours or the agents').",
        "user": "user — only human-scheduled loops fire; agent-created loops are paused.",
        "harman": "harman — only agent-created loops fire; human-scheduled loops are paused.",
        "both": "both — every scheduled loop fires, human and agent.",
    }.get(mode, mode)
    lines = [
        f"# {_STATUS_TITLE}",
        "",
        "The current control posture of this Harman machine, read live from the",
        "settings store. Two independent gates govern unattended work.",
        "",
        "## Automation master switch",
        "",
        f"**{'ON' if auto else 'OFF'}** — "
        + ("scheduled jobs and the autonomous manager may start work on their own."
           if auto else
           "nothing runs unattended; scheduled jobs and the manager are paused."),
        "",
        "## Loop-firing mode",
        "",
        f"**{mode}** — {mode_line}",
        "",
        "This is orthogonal to the master switch: the owner can pause automation",
        "while their own loops keep firing (mode `user`), or license only agent",
        "loops (mode `harman`).",
        "",
        "## System-awareness preamble",
        "",
        "Prepended to every session's system prompt so each one knows it is a node",
        "in this system and how its tools are gated. Empty means no preamble is set.",
        "",
    ]
    lines.append(preamble if preamble else "_(no preamble set)_")
    return "\n".join(lines) + "\n"


def list_docs():
    """Every readable doc: the synthetic status doc first (always current), then the
    whitelisted design files that exist on disk. `bytes` is the payload size so a
    caller can decide what to pull — progressive disclosure over read_doc."""
    status = _status_markdown()
    out = [{"id": _STATUS_ID, "title": _STATUS_TITLE, "description": _STATUS_DESC,
            "bytes": len(status.encode())}]
    for doc_id, (title, desc) in _FILE_DOCS.items():
        p = _doc_path(doc_id)
        if p and p.is_file():
            out.append({"id": doc_id, "title": title, "description": desc,
                        "bytes": p.stat().st_size})
    return out


def read_doc(doc_id):
    """The full text of one doc as {id, title, content}, or None if unknown/missing.
    Resolution is by registered id only — never a caller-supplied path."""
    if doc_id == _STATUS_ID:
        return {"id": _STATUS_ID, "title": _STATUS_TITLE, "content": _status_markdown()}
    p = _doc_path(doc_id)
    if not p or not p.is_file():
        return None
    return {"id": doc_id, "title": _FILE_DOCS[doc_id][0],
            "content": p.read_text(errors="replace")}
