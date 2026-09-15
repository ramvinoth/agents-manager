# Sessions & employees — what they are, and what every session can see

A plain-language answer to the question the design docs bury: *what is the
difference between an "employee" chat session and a "normal" chat session, and
can one session see another?* This is the reference; the "why we built it that
way" rationale lives in ORCHESTRATOR_MCP.md.

## There is exactly one kind of session

Every chat is the same object: a transcript (`.jsonl`) plus a row of viewer
metadata. Claude, Codex, Copilot and Pi all produce one. There is **no separate
"employee session" class** — an employee is a *role tag worn by an ordinary
session*, nothing more.

> "It is a normal session. Same transcript, same MCP, same audit. If it were
> special it would drift from the code path everything else uses."
> — ORCHESTRATOR_MCP.md

What the employee tag adds is a single field on the session's token row:
`session_tokens.employee_level` (`ic < lead < manager`). That level **gates
writes** — which cards it may move, which loops it may edit, whether an action
runs or queues for the owner's approval. It does **not** gate visibility. A
session with no employee link authenticates at `ic` (the least authority) and
still sees the whole system.

## Every session can see every other session

Create a new chat and Harman — and every other session/agent — can see it
immediately, with full detail. Nothing is private between sessions. This is the
point: without total visibility, agents could not see the big picture,
collaborate, or plan. Visibility is delivered in two tiers (progressive
disclosure), both through the built-in Harman MCP:

**Tier 1 — the thin list** (`session_list` → `/api/sessions`): every session on
the host, each row carrying `id, title, project, provider, harness, running,
unread, archived, favorite, modified, size, preview`, plus `persona` (the
employee driving it, when linked).

**Tier 2 — the deep read** (`session_detail` → `/api/session-detail`): for any
one session — its `capabilities` (**skills** and **MCP servers/tools**),
`summary` (cwd, models used, tool calls, token timeline), and `meta` (provider,
model, conversation mode, effort, avatar, goal, system prompt). This is the
"full settings" view: working dir, current model + provider, harness, the lot.

So "which persona is driving which running session, with which tools, in which
directory, on which model" is answerable in at most two calls — for *any*
session, from *any* session.

## The org roster vs. the running fleet

Two entities meet here:

- **Employees** (`employees` table) — the persistent org roster (name, role,
  provider, model, avatar). Identity that outlives any single session.
- **Sessions** — the live work. A session links to an employee via its token's
  `employee_id`, and the list overlay joins the two so a row shows *who* is
  driving it (`persona`).

An employee can have many sessions over time (one per project it works); a
session has at most one employee. Employee identity persists beyond any session.

## The docs MCP

Everything above is self-describing at runtime. `docs_list` / `docs_read` expose
this file, the design docs (charter, MCP/RBAC, Kanban, providers, secrets), and
a live `system-status` doc that reports the current automation switch, loop-firing
mode, and system preamble — the machine describing its own current posture.
