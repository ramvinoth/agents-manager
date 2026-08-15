# ORCHESTRATOR — Kanban / Empire design (v1)

Status: **design (v1)** — extends ORCHESTRATOR.md's charter with Ram's Kanban/empire vision
(2026-08-15). No code until approved. Branch: `feature/orchestrator`.

## The vision (Ram's words, structured)
- **Ram = Founder & CEO.** **Harman (Harness Manager) = the assistant that runs the empire** —
  monitors and manages everything, surfaces to Ram ONLY what truly needs his approval.
- **Employees** are assigned to **projects**; they do the work **through chat sessions**, which are
  their *workspace* for that project. (session = employee's desk for one project)
- **Every chat session has a Kanban board**, connected via an **MCP tool** the session can call to
  create boards, add tasks, move cards, assign work.
- **Ram swipes right on a chat session → Kanban view**, filtered to that employee / project /
  session. From there he can see + manage tasks, create boards, assign.
- **Approval + Questions page**: Harman monitors/manages approvals; an **audit log** records
  everything; Ram is pinged only for the genuinely-needs-CEO items (narrow gate from the charter).
- **Fresh install bootstrap**: first run installs the required **skills + MCP tools** so the whole
  system works out of the box.

## Board model — ONE canonical board, everything else is a filtered VIEW (Ram, 2026-08-15)
Single source of truth: **one `cards` table** holding every card in the empire, plus one board
model (its columns). There are NO per-session board records. Every "board" the UI shows is the same
data through a **view = { filter, column-layout }**:
- Swipe-right on a chat session → main board filtered to `session = X` (⇒ its employee + project).
- Employee view → `assignee = <employeeId>`. Project view → `project = <projectId>`. CEO dashboard → no filter.
A card Emma creates in her session is one write, instantly visible in the project view and the CEO
board. No sync, no drift, no duplication. (Filter predicates + column ordering live pure in `lib/`,
unit-tested.)

## Decisions locked (Ram, 2026-08-15)
- **Board scope**: one common main board; all other boards are pre-filtered views (above). ✅
- **Escalation cadence**: **hybrid** — batch Green-adjacent asks at loop end; interrupt immediately
  only for destructive / secret / money. All actions hit Approvals page + audit regardless; only Red
  pings Ram. ✅
- **Who can hire**: **Harman can create employees AND projects** (within Green autonomy) — not just
  Ram. Creation is logged to the audit trail. ✅
- **Persistence**: Postgres (`db.py`, via DATABASE_URL). **Employee identity** persists beyond any single session.
  **Budget ceiling**: optional, can be turned off. ✅
- **No half-measures**: build the full picture per phasing below; each phase complete + verified, no
  dead code, no stubbed-but-unreachable surfaces. Ram: "strictly do not half ass it."

| Concept | Backing store | Notes |
|---|---|---|
| Employee | new `employees` table (Postgres) | **identity persists across sessions** (Ram's call). Has name, role, default provider/model/convMode, avatar, status. |
| Project | new `projects` table | name, description, owner=CEO, host+cwd ("department"), member employees. |
| Workspace | existing **chat session** | one session = one employee working one project. Links employeeId + projectId in session-meta. |
| Board | ONE `board` (columns config) + `views` (saved filters) | Single canonical board for the whole empire; per-session/project/employee "boards" are just filtered views. Default columns Todo/Doing/Review/Done. |
| Card / Task | one `cards` table | title, body, column, assignee(employeeId), projectId, sessionId, order, createdBy, timestamps. The ONLY card store. |
| Approval | extend `pending_questions`/`pending_plans` pattern → `approvals` table | typed: destructive/secret/money/infra. Harman auto-handles Green; queues Red. |
| Audit log | new `audit_log` table | append-only: who/what/when/target/outcome. Every Green action Harman takes + every Red decision. |

All in the EXISTING Postgres (`viewer` DB) via `viewer/db.py` — new `init_db()` tables + accessors,
mirroring the existing `pending_questions` lifecycle (set/get_open/resolve/delete).

## The MCP tool — `kanban` (per-session)
A new MCP server (pattern: `viewer/permission_mcp.py`) exposing task ops so a chat session (any
agent: Claude/Qwen/Codex) can drive its own board from inside a turn:
- `board_list` / `board_create(name, columns?)`
- `card_create(board, title, body?, column?, assignee?)`
- `card_move(card, column, order?)` · `card_update(card, …)` · `card_assign(card, employee)`
- `card_list(board|project|employee filter)`
- `task_done(card)` → moves to Done + audit entry.
Registered automatically per session (see bootstrap). Writes go through db.py; every mutation
appends to `audit_log`. Harman reads the same tables to monitor.

## Server (viewer) — new surfaces
- `viewer/orchestrator.py`: the registry + queue + Harman's tick. Employee/project CRUD, assignment,
  board/card CRUD (shared by MCP tool + REST), approval queue, audit append.
- `viewer/routes/orchestrator.py`: REST for the app — `/api/org/employees`, `/api/org/projects`,
  `/api/org/boards`, `/api/org/cards`, `/api/org/approvals`, `/api/org/audit`. (Cross-check: no
  duplicate of existing routes — this is net-new surface.)
- `viewer/mcp/kanban_mcp.py`: the MCP server above.
- Approval gate reuses the charter's Green/Red tiers. Harman auto-resolves Green + logs; Red items
  land on the Approvals page and (only these) notify Ram.

## App (mobile) — new surfaces
- **Swipe-right on a chat session** (ChatsScreen row) → **Kanban view** filtered to that
  employee/project/session. (Gesture: reuse the SwipeToReply PanResponder pattern; swipe-right on a
  session row opens the board. Must not collide with existing row actions — verify.)
- **KanbanScreen**: columns + draggable cards (react-native-gesture-handler is already a dep). Create
  board, add/assign/move cards. Filter chips: employee / project / session.
- **Org tab or CEO dashboard**: employees, projects, and the **Approvals & Questions** page
  (Harman's queue) + **Audit log** view (read-only timeline).
- Pure logic in `lib/` (board/card ordering, filter predicates) — unit-tested, per CLAUDE.md.

## Harman's role (the manager loop, from the charter)
- Watches boards + sessions; assigns/unblocks within **Green** autonomy; advances cards.
- **Escalation cadence** (Ram: **hybrid**, confirmed): batch Green-adjacent asks at loop end;
  interrupt immediately only for destructive/secret/money. Everything lands in the Approvals page +
  audit log regardless; only Red pings Ram.
- Optional **budget ceiling** (Ram: optional, can be off): cap concurrent agent-mode sessions / token
  spend; when off, unbounded.

## Organizational learning — employees turn experience into shared skills (Ram, 2026-08-15)
The empire gets smarter over time: when an employee solves something hard or recovers from a mistake,
that lesson becomes a **skill** EVERY employee automatically has next time — nobody repeats the same
struggle. Built on the EXISTING skill system (verified in `viewer/routes/capabilities.py`), not new infra.

**How skills work here (verified):** skills are `SKILL.md` files scanned from three scopes — project
(`<cwd>/.claude/skills`), **user (`~/.claude/skills`) = shared across ALL sessions on a host**, and
read-only plugins. `handle_skill_save` / `resolve_skill_path` already create/update them. The
user-scope dir is therefore a natural **shared company skill library**: write once, every employee's
session loads it automatically on next run.

**The learning loop:**
1. **Capture** — after a turn that solved something non-obvious or recovered from a mistake, the
   employee (or Harman, watching) proposes a skill: a `SKILL.md` with a trigger description + the
   procedure/lesson. Origin card + session recorded (provenance).
2. **Review (governed, so the library stays clean per CLAUDE.md)** — a proposed skill is an **approval
   item**: Harman auto-accepts low-risk, non-overlapping additions and logs them (Green); broad,
   destructive, or duplicate-of-existing ones go to the Approvals page for Ram (Red). Prevents a junk
   pile of near-duplicate skills — same no-duplication discipline as code.
3. **Promote** — accepted skills are written to shared **user-scope** `~/.claude/skills/<name>/SKILL.md`
   via the existing skill-save path, so every employee inherits them. Dedup check first — extend the
   real skill for a solved concept, don't add a second one.
4. **Attribute + audit** — `audit_log` records who learned it, from which card/session; frontmatter
   credits the origin employee. Ram gets a "skills learned this week, by whom" view.
5. **Retire** — stale/superseded skills trashed via the existing delete path (`.viewer-trash`), logged.

**Data:** a `skills_learned` table (Postgres) is the LEDGER — {name, path, originEmployee, originCard,
originSession, status, createdAt} for provenance + the CEO view. Skill CONTENT stays a `SKILL.md` file
so the CLI/agents load it natively; the table indexes it.

**MCP:** the org MCP gains `skill_propose(name, trigger, body, fromCard?)` so an employee captures a
lesson mid-turn without leaving chat. Promotion still passes the governance gate.

**Why governed, not auto-write:** auto-writing a skill every turn would flood `~/.claude/skills` with
overlapping junk — the exact duplication trap we're eliminating. Capture is cheap; promotion is
reviewed (mostly Harman within Green; Ram only for the ambiguous ones).

## Fresh-install bootstrap
A `make bootstrap` (or first-run check in server startup) that ensures a working system on a clean
box: install/register the required **skills** and the **kanban MCP** (+ permission MCP), create the
default board columns, and seed the CEO (Ram) + Harman as the manager identity. Idempotent — safe to
re-run. This is what makes "everything works on fresh install" true.

## Resolved (was "open questions") — all locked with Ram 2026-08-15
1. **Board scope** → ✅ one canonical board; others are filtered views. (See Board model.)
2. **Escalation cadence** → ✅ hybrid (batch Green, interrupt destructive/secret/money).
3. **Employee identity** → ✅ persistent record (name+role+provider+model+avatar+status); sessions are
   its per-project work log. Harman spins up / resumes sessions for an employee on demand.
4. **Who creates employees/projects** → ✅ Harman can (Green, audited) AND Ram.
5. **MVP cut** → the FULL picture is the target (no half-measures). MVP is the first *vertical slice
   that works end-to-end*, then each phase adds a complete layer — NOT a permanently-reduced scope.
   Phasing below is the delivery order; the destination is the whole design.

## Full scope checklist (do not lose sight — Ram: "remember the full picture, don't half-ass it")
- [ ] Postgres: employees, projects, cards, board-columns, views, approvals, audit_log (+ accessors + tests)
- [ ] Employee identity persists; sessions link employeeId+projectId; Harman resumes/spawns on demand
- [ ] ONE canonical board; session/project/employee/CEO are filtered views (pure filter logic in lib/)
- [ ] `kanban` MCP tool auto-registered per session; any agent can create/move/assign cards from a turn
- [ ] REST /api/org/* (employees, projects, cards, views, approvals, audit) — net-new, no dupes
- [ ] App: swipe-right session → filtered board; KanbanScreen (drag/assign/move); CEO dashboard
- [ ] Approvals & Questions page (Harman's queue) + read-only Audit log timeline
- [ ] Harman loop: monitor + assign/unblock within Green; hybrid escalation; only Red pings Ram
- [ ] Harman can hire (create employees/projects), audited
- [ ] Optional budget ceiling (concurrent agent sessions / tokens), toggleable off
- [ ] Organizational learning: `skill_propose` MCP + governed promotion to shared `~/.claude/skills`
      + `skills_learned` ledger (provenance) + "skills learned" CEO view; dedup before write
- [ ] `make bootstrap`: idempotent fresh-install of skills + MCP tools + seed (CEO Ram, manager Harman,
      default columns) — everything works on a clean checkout

## Build phasing (once approved)
- **P0 Data**: db.py tables (employees, projects, boards, cards, approvals, audit_log) + accessors + tests.
- **P1 MCP**: kanban_mcp.py + auto-registration; prove a session can create/move a card.
- **P2 REST + app**: /api/org/* routes; KanbanScreen + swipe-right entry; filters.
- **P3 Harman loop**: monitor/assign within Green; Approvals page + audit; Red→notify Ram.
- **P4 Bootstrap**: make bootstrap (skills + MCP + seed) idempotent; verify on a clean checkout.
- Each phase: tsc/tests green, no dead code, ship to TestFlight, confirm testable.
