# Sessions — what they are, who may do what, and what every session can see

A plain-language answer to the question the design docs bury: *what is the
difference between an agent's chat session and a "normal" chat session, what
gates what it may do, and can one session see another?* This is the reference; the "why we built it that
way" rationale lives in ORCHESTRATOR_MCP.md.

## There is exactly one kind of session

Every chat is the same object: a transcript (`.jsonl`) plus a row of viewer
metadata. Claude, Codex, Copilot and Pi all produce one. There is **no separate
"agent session" class** — an agent role (Agents tab) is a template a session is
started from, nothing more.

> "It is a normal session. Same transcript, same MCP, same audit. If it were
> special it would drift from the code path everything else uses."
> — ORCHESTRATOR_MCP.md

## Two trust layers — different questions, not duplicates

A session's settings show both under **Trust**:

| Layer | Question it answers | Where it lives | Who enforces it |
|---|---|---|---|
| **Harness permission mode** (default / acceptEdits / plan / bypass) | May this CLI run Bash, edit files, touch the machine without a prompt? | `session_meta.permission_mode` → the CLI's `--permission-mode` | The harness (Claude Code) inside its own process |
| **Harman level** (`ic < lead < manager`) | What may this agent do *in the org* — create projects, schedule loops, rewrite the preamble? | `session_meta.level` (per-chat override) → the agent role's `agent_templates.level` → `ic` (`engine.resolve_level`) | The viewer server, in `actions.execute`, for every caller |

They cannot merge: the harness never sees org actions (they arrive as MCP tool
calls that are only transport to `/api/*`), and the server never sees a local
`rm -rf`. MCP and skills are how a harness *reaches* Harman; the gate is the
server, so a Codex or Copilot session, the web UI and the phone app all meet the
same rule.

The level **gates writes**, never visibility. Asking above your level is not a
dead end: the action queues for the owner's approval (`queued:scope`, a reason
is required) instead of a 403. Changing a session's level is itself a Red
action (`session_level_set`, never one's own), and the human's own role caps
any session they drive (`orglogic.effective_level` takes the weaker).

## Every session can see every other session

Create a new chat and Harman — and every other session/agent — can see it
immediately, with full detail. Nothing is private between sessions. This is the
point: without total visibility, agents could not see the big picture,
collaborate, or plan. Visibility is delivered in two tiers (progressive
disclosure), both through the built-in Harman MCP:

**Tier 1 — the thin list** (`session_list` → `/api/sessions`): every session on
the host, each row carrying `id, title, project, provider, harness, running,
unread, archived, favorite, modified, size, preview`.

**Tier 2 — the deep read** (`session_detail` → `/api/session-detail`): for any
one session — its `capabilities` (**skills** and **MCP servers/tools**),
`summary` (cwd, models used, tool calls, token timeline), and `meta` (provider,
model, conversation mode, effort, avatar, goal, system prompt). This is the
"full settings" view: working dir, current model + provider, harness, the lot.

So "which persona is driving which running session, with which tools, in which
directory, on which model" is answerable in at most two calls — for *any*
session, from *any* session.

## No separate roster

An earlier design kept an `employees` table (name, role, provider, level) and a
manager tick that matched cards to employees and spawned sessions. It was retired
(card 146): roles already live in agent templates, work reaches a session through
a card on its board (board_wake) or a scheduled loop, and the level lives on the
template or the chat. Old audit rows may still name `employee:<name>`.

## The docs MCP

Everything above is self-describing at runtime. `docs_list` / `docs_read` expose
this file, the design docs (charter, MCP/RBAC, Kanban, providers, secrets), and
a live `system-status` doc that reports the current automation switch, loop-firing
mode, and system preamble — the machine describing its own current posture.
