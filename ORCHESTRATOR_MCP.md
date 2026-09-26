# ORCHESTRATOR_MCP — the internal MCP, layered RBAC, and skill distillation

Design + build tracker. Build steps 1-3 are SHIPPED and live (see §9 — struck-through
items); steps 4-10 remain design-only, pending sequencing, audit data, and Ram's §14
decisions. The original "no code until agreed" gate applied to the whole shape; the agreed
foundation (principal resolution, `execute()`, the read-only MCP tier) is now code.

Goal, in Ram's words: *a system that can see everything, all chat sessions with roles
and RBAC, which can control and orchestrate other agents, and can always distill and
learn a skill/sub-skill routing subsystem connected to all chat sessions as an MCP —
with RBAC-controlled user management — distilling skills from the user's messages,
judgements, intent, goal and clarity.* And: **installable on any machine.**

Plus, from the second pass: *harvesting agents that Harman creates on first install,
running in a loop and also triggered on demand as Harman wants; Harman approves
everything on Ram's behalf and surfaces only genuinely real questions and decisions.*

And the third pass, which is the product the rest of this doc serves: *one prefixed
Harman chat session, pinned to the top by default, as Ram's only interface — a second
brain that reasons, plans, creates tasks and delegates but does not act; where Ram
supplies only real-world resources and decisions, and is not interrupted for silly
things, because the user's time is precious.* §12.

---

## 0. What already exists (verified, cited)

Most of this is built. Naming it prevents building a second copy.

| Piece | Where | State |
|---|---|---|
| Two-gate policy: scope + risk | `orglogic.allowed` (124-162), `orglogic.classify_action` (79-107) | works, table-driven, pure, unit-tested |
| Per-session identity token | `engine.py:1109-1126` → `session_tokens` (`db.py:93-102`) | works, survives restart |
| Token → `{employee, level}` | `engine.py:806-827` | works, DB fallback |
| MCP transport pattern | `viewer_mcp.py` — dumb `(method, path)` proxy, policy server-side | correct pattern, reuse verbatim |
| Remote MCP shipping | `remote.py:1305-1341` (SFTP + reverse tunnel) | works for remote hosts |
| Approval + audit ledger | `approvals`, `audit_log` (`db.py:155-173`) | tables exist |
| Per-session fact extraction | `session_analysis()` (`engine.py:1690`), cached by (mtime,size), **fleet-aware over SSH** | works — this is the harvester |
| Skill write/list | `skills.py` | works, **local disk only** |
| Skill promotion + dedupe gate | `routes/orchestrator.py:324-358` | works, but voluntary + name-only dedupe |
| **Harman autonomous loop** | `orchestrator.py:121` `harman_tick()`, driven by `engine.py:198` | **built and live** — survey → plan → assign → spawn → escalate |
| **Loop safety rails** | `HARD_CAP=4`, budget, in-progress guard, self-throttle (`orchestrator.py:9-13, 26`) | works |
| **Session spawning** | `_spawn_employee_session` (`orchestrator.py:82-118`) | works — this is how a harvester agent gets created |
| **First-install bootstrap** | `bootstrap.py` (`make bootstrap`) — tables, seeds Ram + Harman, skills dir, Harman config | works, idempotent |

Two consequences worth stating plainly, because they shrink the build:

- **The loop already exists.** "Runs in a loop, and on demand as Harman wants" is
  `harman_tick()` plus a `spawn` intent. It does not need designing — it needs a new
  *kind* of card. §5A.
- **The first-install hook already exists.** `bootstrap.py` already seeds Harman as an
  employee. Seeding the harvester is four lines in the same file. §5A.

### Five defects this design must fix

1. ~~**`users` has no role** (`db.py:62-68`). Every logged-in user is hardcoded
   `"manager"`. There is no human RBAC today.~~ **Fixed in build step 1**: `users.role`
   is real, `_resolve_principal` attaches one principal, and authority is
   `effective_level(human_role, session_level)` — the weaker of the two.
2. **Red approvals are inert.** `_org_do` queues them (orchestrator.py:50-55) but
   `_p_org_approvals_resolve` executes only `kind == "skill"`.
   Approving a Red infra action does nothing — the `mutate` closure died with the request.
   **This also blocks Harman approving on Ram's behalf**: there is nothing to execute.
3. **Skill truth is one machine's filesystem.** `skills_learned` stores a `path`
   (`db.py:187`); the body lives at `~/.claude/skills/<n>/SKILL.md`. A skill learned on
   the Mac does not exist on a remote host. Same root cause as "not installable."
4. **Topology is hardcoded, and facts the nodes publish are re-typed by hand.**
   `config.py:67-87` names `100.115.120.89` four times; `push.py:30` defaults to
   `com.suhai.agents`. Separately, `providers.py:55` hand-types `contextLimit` while the
   engine already reports `max_model_len` and the discovery route
   (`routes/providers.py:84`) discards it. Same shape twice: a fact that lives on the node,
   copied into our source. §7A.
5. **`bootstrap.py` seeds employees but no `users` row** — and the employee it seeds is
   a *person by name*: `{"name": "Ram", "role": "Founder/CEO"}` (`bootstrap.py:19`), the
   only literal "Ram" in shipped code (the rest are comments). So a fresh install has no
   owner account for §2's human ceiling to resolve against, *and* it seeds a stranger as
   CEO on someone else's hardware. The owner is a role, resolved at runtime — never a
   name in source. §7.2.


---

## 1. Source of truth

| Fact | Today | Target |
|---|---|---|
| Human authority | none — hardcoded `manager` | `users.role` in Postgres |
| Who the owner is | `"Ram"` in `bootstrap.py:19` | `users.role == "owner"`, resolved at runtime |
| Session authority | `session_tokens.employee_level` | unchanged ✅ |
| Effective authority | n/a | derived: `min(human_role, session_level)` — stored nowhere |
| Delegation scope | n/a | derived from `audit_log` outcomes (§2B) — stored nowhere |
| Skill body | disk; DB holds a path | **DB row is truth; disk is a materialized cache** |
| Pending action | a dead Python closure | **serialized intent in `approvals.detail`** |
| Service endpoints | machine-named defaults | **the node declares them; we probe** (§7A) |
| Model context window | hand-typed per preset | **the engine's `max_model_len`** (§7A) |

Rule applied throughout: *the fact lives where it is true; everything else derives.*

---

## 2. Layered RBAC — `min(ceiling, floor)`

Two independent principals, one number.

```
human (users.role)     : viewer < operator < owner
session (employee_level): ic < lead < manager        [orglogic.LEVELS, unchanged]

effective = min(rank(human_role), rank(session_level))
```

- A **viewer** human cannot gain authority by spawning a manager-level agent.
- An **owner** human still cannot make an `ic` session delete things.
- A session with no human owner (a cron/loop spawn) uses the **install owner's** role
  as its ceiling — never an implicit escalation.

Single-owner installs get today's behaviour free: the sole `owner` never lowers the
ceiling, so `effective == session_level` and nothing changes.

`orglogic` gains one pure function; the existing `allowed()` is untouched:

```python
HUMAN_ROLES = ("viewer", "operator", "owner")

def effective_level(human_role, session_level):
    """Authority is the WEAKER of the two principals. Unknown → lowest."""
```

Deny-by-default survives: `_MIN_LEVEL` lists what is granted; anything unlisted is denied
(`orglogic.py:159-161`). Adding a tool without adding a policy row = the tool is dead, not open.

---

## 2A. Harman approves on Ram's behalf — delegation, not bypass

Ram: *"it can approve everything on my behalf and only surface to me with genuinely real
questions and decisions that it requires me."*

The wrong implementation is to widen Green until nothing is Red. That destroys the audit
trail and the distinction between "safe" and "someone chose this" — and it cannot be
undone once the classifier is gutted.

The right implementation keeps the Red classification exactly as-is and adds **one
delegated approver**. Red still means "a decision was made"; it stops meaning "Ram is
interrupted."

```
Harman = a principal with human_role "owner"  (§2's ceiling)
       + a DELEGATION policy saying which approval kinds it may resolve autonomously
```

`approvals` already carries `kind` (`db.py:157`) and `orglogic._RED_KINDS` already names
four: `destructive | secret | money | infra`. That existing field is the delegation
boundary — no new taxonomy.

```python
# orglogic.py — pure, table-driven, sits beside _RED_ACTIONS.
_DELEGATED_KINDS = {"infra", "destructive"}   # Harman may self-approve
_RESERVED_KINDS  = {"secret", "money"}        # ALWAYS Ram

def delegable(approval_kind, *, reversible, blast_radius):
    """True if Harman may resolve this approval itself."""
```

### The three tests an approval must pass to be self-approved

An approval is delegable only when **all three** hold. Any failure surfaces to Ram.

1. **Recoverable** — the action has a stated undo path (a backup exists, it's a card
   move, the file is in git). `session_delete` with a verified backup: recoverable.
   Without one: not.
2. **Contained** — blast radius is this install. Touching a foreign host, DNS, a tunnel,
   or a shared service is never delegable (`_RED_ACTIONS` already lists these).
3. **Precedented** — Ram has approved this action kind before, or it follows from a
   stated preference. First-of-kind always surfaces. This is what makes delegation *earn*
   scope instead of being granted it.

Precedent is not a new store: `audit_log` already records every `approval_resolve` with
actor and resolution (`routes/orchestrator.py:280`). "Has Ram approved this action kind
before?" is a query over data already being written.

### What always reaches Ram

- `secret` and `money` kinds — unconditionally. Cost and credentials are not delegable.
- Anything failing recoverable / contained / precedented.
- **Genuine ambiguity**: two defensible paths where the choice is a preference, not a
  correctness question. This is Ram's "genuinely real decisions" — and it is the one
  category no table can classify. It is raised by the *agent*, via `AskUserQuestion`, not
  inferred by policy.
- Anything Harman self-approved that then **failed** — reported after, not asked before.

### Non-negotiable rails

- **Separation of duties: an agent may never approve its own escalation.** If
  `approval.created_by == the resolving principal`, delegation is refused and it goes to
  Ram. Without this rail, any session escalates to Red and then rubber-stamps itself,
  and the entire gate is theatre. This is the single most important line in this section.
  **Built in step 2** as `orglogic.may_resolve` — it had to land the moment approvals
  started executing, and it binds *humans* too: an operator has enough authority to resolve
  approvals, so exempting people would leave the identical hole wearing a person's name.
  The owner is never caught by it — acting at the UI they never queue in the first place.
- Self-approvals are audited as `resolution="approved:harman"` — distinguishable from
  `approved` forever. Ram can always ask "what did you approve without me?"
- A **kill switch**: `delegation_enabled` in Harman config, default **off**. Delegation
  is opt-in per install, not a surprise on upgrade.
- A **rate rail**: N self-approvals per hour (reuse the `HARD_CAP` pattern from
  `orchestrator.py:26`). A runaway loop hits a ceiling instead of draining an account.

### The master switch, above all of it

`delegation_enabled` above scopes one behaviour: whether Harman may *approve* on Ram's
behalf. Ram asked for something broader — *"pass the full system with a single switch and
keep it off"* — so there is one flag above every rail here: **`automation_enabled` in
Harman config, default off**. While it is off, nothing starts *without a person asking*:
not Harman's manager tick, not any agent-scheduled loop or one-shot. The owner's own
scheduled loops ARE a person asking — they follow the loop-control `mode` alone, so the
switch pauses the machine's autonomy, not the human's calendar. It is the switch you
flip before leaving the machine alone, and the state a fresh install ships in.

**Enforced at one point, not one per path.** `engine.loop_scheduler` is the only thread
that starts work nobody asked for, so both unattended paths are gated inside it: the loop
launcher (`fire_due_loops`) intersects the origins licensed by `mode` with the switch —
the agent side of the set is halted when it is off — and `harman_tick` is skipped outright.
Gating each path at its own call site would make "everything is paused" a claim that
decays the first time somebody adds a path, which is exactly the failure the switch
exists to prevent. Anything added to that thread later is paused by default.

Four properties are load-bearing:

- **Unknown means off.** A missing key, a config written before the switch existed, a
  corrupt file, an exception while reading — all resolve to off. The fail-safe direction
  for "is it safe to leave this alone" is only ever *paused*.
- **Paused, not skipped.** A due loop's `nextRun` is left untouched while off, so resuming
  fires each loop once on its own schedule rather than replaying every run that came due
  during the pause.
- **Read fresh every pass.** No caching, so a pause takes effect within one 5s tick.
- **Reaping still runs.** Finished jobs are still collected and their session tokens still
  expired while paused — "paused" must not come to mean "holding live credentials open."

**Easy to pull, hard to push.** A kill switch the automation can flip back on is not a kill
switch, and the first draft of this was exactly that: `harman_config` is a plain
manager-level green action, and a Harman-role agent session resolves to `manager`
(`engine._emp_level`) under the owner's ceiling — so it could have POSTed its own resume.
The flag is therefore *two actions over one body*, the same shape as
`skill_propose`/`skill_promote`: the risk lives in the **direction** of the change, not in
the write.

| action | min level | risk | what actually happens |
|---|---|---|---|
| `automation_pause` | `ic` | green | any session stops the machine, immediately — stopping must never sit in a queue |
| `automation_resume` | `manager` | **red** | the owner at the UI resumes; an agent's resume becomes an approval |

Three consequences worth stating:

- **The value comes from *which action ran*, never from an argument.** Intents are persisted
  to `approvals.detail` and replayed later, so an args-driven flag would let a caller name
  the safe action while carrying the dangerous payload — and would let an approval queued as
  "pause" execute as "resume".
- **`set_config` cannot touch the flag.** `automation_enabled` is not in `_PATCH_KEYS`, and
  the route does not fold it into the `harman_config` patch; `orchestrator.set_automation` is
  the single writer. Without that, un-pausing stays reachable as one extra key on an ordinary
  config write.
- **`self_approves` is what gives the red gate teeth.** It is `owner and not session_level`,
  so the owner tapping the switch resumes with no ceremony, while a model-chosen resume —
  which always carries a session level — queues for a human however high its ceiling.

It is surfaced as a single switch on the app's Profile screen, and it is the one control
in the app that is **not** optimistic: the toggle moves only after the server confirms.
Everywhere else a snapped-back switch is cosmetic; here it would tell the owner the
machine is idle when the request never landed.

Note the ordering constraint: delegation is meaningless until §3 makes approvals
executable. Both live in build step 2 — the rail itself is now built; what remains here
is the *delegation* half (the three tests, the `approved:harman` marker, the kill switch),
which step 5 adds on top of it.

---

## 2B. Accountability score — autonomy is earned, not granted

§2A's third test ("precedented") is the only one that is a *judgement* rather than a
property of the action. The accountability score is that test made into a number, so
delegation scope is derived from track record instead of configured by hand.

**Subject is a pair, not a principal.** A score is per `(principal, action_kind)` —
"Harman on `infra`", not "Harman". Being reliable at moving cards earns nothing on
`session_delete`. A single global trust number is the failure mode this avoids.

### Computed from evidence already written

No new self-report, no new store. Every input already lands in `audit_log` and
`approvals` (`db.py:155-173`):

| Signal | Source | Weight |
|---|---|---|
| Ram approved this kind | `approvals.resolution = "approved"` | `+1` |
| Ram **rejected** it | `resolution = "rejected"` | `−λ` (λ=3) |
| Harman self-approved and it succeeded | `"approved:harman"` + `audit done` | `+0.5` |
| Self-approved and it **failed/was reverted** | `"approved:harman"` + `audit error`, or the card returning from Review | `−μ` (μ=2) |

```
score(p, k) = Σ decayed(weight) / Σ decayed(|weight|)      → [-1, 1]
decayed(w)  = w * 0.5 ** (age_days / HALF_LIFE)            HALF_LIFE = 30d
```

Four properties, each deliberate:

- **Starts at 0, not 1.** An unknown pair has no track record, so it cannot
  self-approve — the same deny-by-default posture as `_MIN_LEVEL` (`orglogic.py:159`).
  A fresh install grants zero autonomy and earns it.
- **A rejection is expensive.** λ=3 means one explicit "no" from Ram outweighs three
  silent yeses. Human correction is the highest-quality signal in the system; weighting
  it equally would let volume drown out judgement.
- **It decays.** Good behaviour six months ago does not buy trust today. Without decay
  the score is a ratchet that only ever loosens.
- **A self-approval is worth half a real one, and a failed one costs four times what it
  earned.** Harman cannot bootstrap its own trust by approving easy things.

### What it gates

```python
def delegable(kind, *, reversible, contained, score, n):
    if kind in _RESERVED_KINDS:  return False        # secret/money — never
    if kind not in _DELEGATED_KINDS: return False
    return reversible and contained and n >= N_MIN and score >= TAU
```

`N_MIN = 3`, `TAU = 0.8`. Below either, the approval surfaces to Ram — which is also
how the score recovers, since a human decision is a `+1` or a `−3`.

### Rails

- **A principal can never write its own score.** It is derived on read from
  `audit_log`, which no MCP tool can write directly (`audit_append` is called by
  `execute()`, never by a tool). Nothing to game.
- **It must be explainable.** `accountability(principal, kind)` returns the number *and*
  the rows behind it. "Why is this 0.4?" has a concrete answer, always.
- **Score never widens Green.** It only decides who resolves a Red approval. A low score
  means more reaches Ram; a high score never makes a Red action Green.

The same evidence-from-audit shape is reused for **node reliability** in §7A — different
subject, different use (placement, not autonomy), identical principle: measure what
already happened rather than asking the thing to rate itself.

---

## 3. Actions become serializable intents (the Red-gating blocker)

This is the load-bearing refactor. Ram chose "everything, with Red gating" — which is
only real if approving a queued action **executes** it. It is also the prerequisite for
§2A: Harman cannot approve on Ram's behalf if approval does nothing.

Today `_org_do(action, level, actor, target, mutate)` takes a closure. Replace with a
registry of named handlers over plain data:

```python
# viewer/actions.py — the ONLY place a mutating action is defined.
ACTIONS = {
  "card_move":      (lambda a: db.card_move(a["card_id"], a["column_id"], a["position"])),
  "session_delete": (lambda a: engine.session_delete(a["host"], a["session"])),
  ...
}
```


An intent is JSON: `{"action", "args", "actor", "host", "cwd"}` — storable in
`approvals.detail` (already `JSONB`, `db.py:159`).

```
execute(intent, human_role, session_level):
    lvl = effective_level(human_role, session_level)
    if not orglogic.allowed(intent.action, lvl):  → audit denied:scope, 403
    if orglogic.classify_action(intent.action) == "red"
       and not orglogic.self_approves(human_role, session_level):
                                                  → approval_open(detail=intent)
                                                    audit queued:red, return {queued}
    result = ACTIONS[intent.action](intent.args)   → audit done
```

`self_approves` is why a re-dispatch on approval executes instead of re-queueing: a
Red action escalates TO the owner, so when the owner is the actor — at the UI, no
agent session in the loop — there is nobody left to ask and the click IS the approval.
An agent never self-approves whatever its ceiling (a non-empty `session_level` means a
MODEL chose the action), which is the same separation-of-duties rail as §2A. Keep this
predicate — dropping it would queue an approval addressed to the person who clicked.

`approval_resolve(approved)` then calls `execute()` again on the **stored intent**,
with the approver's role and an empty session level (the approver acts as a human, so
`self_approves` lets the stored intent through). One code path, no second policy copy.
The `kind == "skill"` special case (orchestrator.py:266-279) collapses into this and is deleted.

Three properties fall out: deferred execution works; `audit_log.target` holds the exact
replayable intent; and MCP, HTTP and UI cannot drift apart because there is one `execute`.

---

## 4. One resolved principal, and the end of `PUBLIC_API`

`server.py:83` exempts 15 paths from auth so MCP subprocesses can reach them; each
handler then re-checks the token itself (`orchestrator.py:24-39`). At ~60 tools that is a
60-entry auth-bypass list where one forgotten check is an unauthenticated hole.

Invert it. `_gated()` (`server.py:118-122`) resolves the caller **once** and attaches a
principal to `_Req`:

- cookie / Bearer → `{kind:"app", human_role, session_level:""}` — a human at the UI has
  no *session* principal, so authority is the role's ceiling, not a hardcoded level.
- `X-Viewer-Session` + `X-Viewer-Token` → `validate_session_credential()` →
  `{kind:"mcp", human_role: <the install owner's role>, session_level}`. Either per-run
  token (perm or kanban) authenticates: both are minted by the same run for the same
  child process and confer the same authority, so they are one credential, not two.
- neither → 401 before any handler runs

`PUBLIC_API` shrinks to five: the four genuine pre-auth endpoints
(`/api/auth/me|signin|signup|state`) plus `/api/push/unregister`, which must succeed
*after* a session is gone so a device can drop its own token on logout (`push.py:31-33`).
`X-Kanban-*` headers keep working as aliases so a subprocess started before the upgrade
is not broken mid-flight.

---

## 5. Two objects: observations vs. skills

Ram's choice. An **observation** is a fact about Ram or this work (*"wants terse replies"*,
*"rejected approach X because Y"*). A **skill** is a transferable procedure (*"how to ship
to TestFlight"*). Merging them pollutes the shared skill library with personal preference.

```sql
CREATE TABLE observations (
  id SERIAL PRIMARY KEY,
  session_id  TEXT NOT NULL,
  kind        TEXT NOT NULL,   -- intent | judgement | goal | clarification | correction
  body        TEXT NOT NULL,
  evidence    JSONB,           -- {turn, quote} — provenance, always
  confidence  REAL DEFAULT 0.5,
  distilled   BOOLEAN DEFAULT FALSE,
  created_at  DOUBLE PRECISION NOT NULL
);
ALTER TABLE skills_learned ADD COLUMN body TEXT NOT NULL DEFAULT '';  -- DB is truth
```

The five `kind` values are exactly Ram's list: intent, goal, judgement, clarity
(→ `clarification`), plus `correction` (a judgement with a rejected alternative).

### The pipeline

```
session transcript
   └─ session_analysis()          [engine.py:1690 — EXISTS, cached, fleet-aware]
        └─ observation harvest    [+ explicit MCP observe() for in-turn capture]
             └─ distiller         [N related observations → ONE candidate skill]
                  └─ skills_learned(status=proposed)
                       └─ dedupe → novel: active | overlap: approval (existing gate)
                            └─ materialize to every host that needs it
```

Harvesting is **automatic** (from analysis, which already runs) and **explicit** (an
`observe` MCP tool for the moment a correction lands). Distillation only fires on a
threshold — N observations sharing a concern — so one offhand remark never becomes a skill.

`dedupe_skill` is name-string matching only (`orglogic.py:304-322`). Adequate now; it will
miss semantic duplicates at volume. Explicitly deferred, not solved — flagged here so it
isn't mistaken for a solved problem.

---

## 5A. The harvester: an agent Harman creates on first install

Ram: *"auto-harvested skills by an agent/chat session within the system that the Harman
orchestrator creates on first install, so that this agent runs in a loop and also gets
triggered on demand as the Harman agent wants."*

The distiller is **not a service**. It is an employee, working cards, on the same board as
everything else — because judging whether five observations amount to a transferable skill
needs a model, not a `for` loop, and because that reuses machinery that already runs.

### Why an agent and not a background thread

`plan_assignments` → `_spawn_employee_session` → work → advance already exists
(`orchestrator.py:82-118, 121-189`). A thread would be a second, unaudited execution path
for the same job — the parallel-code-path trap. As a card, the distiller inherits budget,
`HARD_CAP`, the in-progress guard, audit, and Ram's board visibility **for free**.

### First install (`bootstrap.py`, ~4 lines beside the existing seeds)

`bootstrap.py:18-21` already seeds Ram and Harman. Add one more:

```python
{"name": "Scribe", "role": "Distiller", "level": "ic"},
```

Plus an internal project ("Harman Internal") owning the distillation cards, so the
harvester never needs `projects` to be non-empty for Ram's real work. Idempotent, dedupes
by name, same as the existing seeds.

### Loop + on demand — one mechanism

Both triggers are *"a card appears in the Scribe's column."* No second pathway:

- **Loop**: `harman_tick` counts undistilled observations. Over threshold → create a
  `distill` card. The existing planner assigns and spawns it. Self-throttled by the
  existing `interval`.
- **On demand**: Harman (or any session with the `distill_request` tool) creates the same
  card. Identical downstream path.

The in-progress guard (`_running_card_ids`, orchestrator.py:60-67) already prevents two
Scribes running at once. Nothing new to build for concurrency.

### Least privilege — the Scribe is `ic`, deliberately

It reads observations and proposes skills. It has **no** orchestration tools: it cannot
spawn, delete, steer, or approve. Its `skill_propose` still passes the existing dedupe
gate (`routes/orchestrator.py:342`) — novel promotes, overlap queues.

Failure mode this closes: **a self-amplifying loop** where the distiller writes a skill
that changes how sessions behave, generating observations that produce more skills. Rails:
the Scribe cannot approve its own proposals (§2A separation of duties), skill promotion is
Green-but-audited, and `_DELEGATED_KINDS` excludes `skill` — so an overlapping skill
always reaches a human or Harman, never self-merges.

### What the Scribe is told

Its system prompt is the one genuinely new artifact, and it encodes the §5 distinction:
an **observation** is a fact about Ram; a **skill** is a procedure anyone could follow.
It proposes a skill only when observations converge on a repeatable procedure — and it
uses `AskUserQuestion` when the distinction is genuinely unclear rather than guessing.

---

## 6. Materialization IS routing

There is no selector to build. Claude Code already routes skills by description matching.
What we control is **which skills exist on disk for a given session's scope** — that is the
routing decision, and it's one mechanism, not two.

```
materialize(host, scope, skill_ids):
    for each skill: skills.write_skill(name, body, scope, cwd)   # skills.py, extended
```

- `scope="user"` → available to every session on that host
- `scope="project"` → only sessions in that cwd (this is sub-skill routing)
- remote hosts → write over the SFTP channel `remote.py` already opens

Because the body is now a DB column, a skill learned on any node lands on every node that
needs it. This is what makes the fleet coherent *and* is the same change that makes the
system installable — one fix, two problems.

---

## 7. Installable anywhere

Gate question #2: a new node must self-configure with **zero hand-copied values**.

`bootstrap.py` is already the fresh-install entrypoint (`make bootstrap`) and is already
idempotent. **Extend it — do not write a second installer.** The gaps are what it does
*not* yet do:

1. **`pyproject.toml`** — real dependency list (derived from imports, not guessed).
   There is currently no `requirements.txt` or `pyproject.toml` at all.
2. **Seed the owner user — and stop hardcoding who that is.** `bootstrap.py` seeds
   *employees* (`_SEED_EMPLOYEES`) but never a `users` row, so §2's human ceiling has
   nothing to resolve against (defect §0.5). Worse, the seed itself names a person:
   `{"name": "Ram", "role": "Founder/CEO"}` (`bootstrap.py:19`) — the only literal "Ram"
   in shipped code. On someone else's hardware that seeds a stranger as CEO.
   Bootstrap should create the first `users` row from the install (env / prompt / first
   signup), mark it `role="owner"`, and create the matching employee from *that* name.
   **Harman stays hardcoded** — it is a component of the system, not a person.
3. **Seed the Scribe + internal project** (§5A) — beside the existing seeds, same dedupe.
4. **Config file.** `~/.claude/.viewer-harman.json` already exists for Harman
   (`orchestrator.py:25`). Widen that pattern to service endpoints rather than inventing
   `~/.harman/config.toml`: precedence env → file → defaults, where **no default names a
   machine**. `SPEECH_SERVICE_URL` etc. (`config.py:67-87`) default to empty = feature off,
   not "point at Ram's tailnet". `APNS_TOPIC` (`push.py:30`) gets no default.
5. **Service unit from a template** for the detected platform, replacing hand-assembly of
   `deploy/com.harman.viewer.plist` / `deploy/harman-viewer.service`.
6. **Schema is the migration.** `db.py` already uses `CREATE TABLE IF NOT EXISTS` +
   `ALTER ... ADD COLUMN IF NOT EXISTS`, and `bootstrap.py` already calls `init_db()`.
   Keep that; nothing new.

**Naming rule, applied everywhere below.** The owner is a *role*, resolved at runtime from
`users.role == "owner"` — never a name in source. That is why §2A says "the owner" where it
once said "Ram", and why §12's pinned session addresses whoever installed it. Prose in this
doc says "Ram" because Ram is *this* install's owner — code must not.

Acceptance test, and it must pass on a clean box: *fresh machine, `pip install`,
`make bootstrap`, log in, spawn a session, watch the Scribe distil its first skill — with
no file copied from Ram's Mac, and no occurrence of "Ram" anywhere in the running system.*

---

## 7A. Capability routing — nodes advertise, Harman places

The fleet is not a flat list of SSH hosts. Today it is 3×3090 serving LLM, GPU3 serving
STT/TTS, a box that can run video, and laptops that are CPU-only. §7 makes the software
installable; this makes the *fleet* coherent — and the two are the same fix, because both
fail for the same reason: **the topology is hardcoded.**

### The defect, concretely

`config.py` hardcodes one machine three times:

```python
SPEECH_SERVICE_URL    = env("HARMAN_SPEECH_URL",    "http://100.115.120.89:8095")
TTS_STREAM_URL        = env("HARMAN_TTS_STREAM_URL","http://100.115.120.89:8097")
VERIFY_SERVICE_URL    = env("HARMAN_VERIFY_URL",    "http://100.115.120.89:8095")
```

That is not configuration, it is a topology baked into source. Move the GPU box's IP and
three constants are wrong. Install on someone else's hardware and it silently points at
Ram's tailnet. Add a second speech node and there is nowhere to put it.

### Nodes declare what they can do

Hosts are already stored, with credentials, in `~/.claude/.viewer-hosts.json`
(`config.py:202`), written by the host-save handler (`routes/auth.py:235-248`). Each entry
gains one field — no new store, no new file:

```jsonc
"suha-ai": {
  "label": "...", "host": "...", "user": "...",        // existing
  "capabilities": {
    "llm":   [{"url": "http://…:18020", "model": "qwen3.8-27b"}],
    "stt":   [{"url": "http://…:8095"}],
    "tts":   [{"url": "http://…:8097", "stream": "aac"}],
    "video": [],
    "cpu":   {"cores": 32}
  }
}
```

Then every consumer asks for a **capability**, never a hostname:

```python
# viewer/capabilities.py — pure resolution over the hosts dict.
def resolve(capability, *, model=None):
    """Endpoints that can serve `capability`, best first. [] = feature off."""
```

`config.SPEECH_SERVICE_URL` becomes `resolve("stt")[0]`. The constants disappear; the
`HARMAN_*_URL` env vars stay as a single-node override so nothing breaks mid-flight.

### Discovered, not typed — and this is the second instance of the same bug

The capability block should be **probed**, not hand-written. An `/v1/models` response
already carries everything needed. Verified live just now against GPU0:

```
$ curl -s http://100.115.120.89:18020/v1/models
{"data":[{"id":"qwen3.8-27b", "max_model_len":245760, "owned_by":"vllm", …}]}
```

The engine states its own context window. But `providers.py:55,139,146,171` hand-types
`contextLimit` per preset, and the discovery route (`routes/providers.py:84`) throws
`max_model_len` away — it keeps only `r.get("id")`. So a number the engine publishes is
transcribed by a human into a second place, where it can silently disagree.

This is the identical shape as the four hardcoded URLs: *a fact that lives on the node,
copied into our source.* One `capability_probe(url)` fixes both — it fills the block
above and sets `contextLimit` from `max_model_len`, with the hand-typed value demoted to
a fallback for engines that do not report one.

### Placement

`_spawn_employee_session` (`orchestrator.py:82-118`) currently derives cwd from the
project and nothing else — every session runs wherever the viewer runs. With capabilities
declared, placement becomes a filter and a sort:

1. **Filter** to nodes offering every capability the card needs (a video card needs
   `video`; a distill card needs only `llm`).
2. **Sort** by, in order: *prefix affinity* (the node already holding this session's KV
   cache — the 8x measured penalty for moving is the single largest placement cost),
   then free capacity, then node reliability.
3. **Empty result is not an error.** No node offers `video` → the card waits with a
   stated reason. It must never fall back to a paid API or a wrong node silently.

Node reliability reuses §2B's shape: derived from `audit_log` outcomes for work placed
there, decayed. A node that fails work stops receiving it, without anyone editing a
config.

### Rails

- **No default names a machine.** Absent capability → feature off, never a guessed URL.
  (Same rule as §7.4, applied to the fleet.)
- **Capability ≠ authority.** A node advertising `llm` does not gain RBAC rights.
  Placement decides *where*, §2 decides *whether*. Keeping these orthogonal is what stops
  "add a node" from becoming a privilege escalation.
- **Probe results expire.** Cache with a TTL and re-probe; a stale capability block is
  how you route to a service that died an hour ago.
- **Deleted with the host.** No orphan capability rows to garbage-collect — the field
  lives inside the host entry.


---

## 8. Tool manifest (~60), by tier

Every tool = one row in `_MIN_LEVEL` + one entry in `ACTIONS`. Levels below are the
**session** requirement; the human ceiling applies on top.

| Tier | Tools | Min level | Gate |
|---|---|---|---|
| **See everything** | `session_list` (all hosts), `session_read`, `session_summary`, `session_analysis`, `chat_status`, `board_list`, `card_list`, `audit_tail`, `approval_list`, `project_list`, `employee_list`, `host_list`, `skill_list`, `capability_list`, `observation_list`, `accountability` | `ic` | none |
| **Orchestrate** | `session_spawn`, `session_send`, `session_steer`, `session_interrupt`, `queue_remove`, `session_meta_set`, `session_fork`, `session_rename`, `card_*`, `task_done`, `loop_*`, `template_*`, `distill_request` | `ic` / `lead` | Green |
| **Re-org** | `provider_set`, `convmode_set`, `skill_grant`, `skill_revoke`, `skill_materialize`, `mcp_grant`, `host_save`, `capability_probe`, `employee_create`, `project_create`, `approval_resolve` | `lead` / `manager` | Green, audited |
| **Destructive** | `session_delete`, `provider_delete`, `backup_restore`, `card_delete`, `skill_delete` | `manager` | **Red → intent queued** |
| **Learning** | `observe`, `skill_propose` | `ic` | Green |
| **Never a tool** | `auth/*`, `env/value`, provider key fields, `terminal/ws`, `browser/ws`, `voice/ws` | — | — |
| **Excluded — Claude has these natively** | `fs/*` (9), `git/*` (5), download/upload, **escalation (`AskUserQuestion`)** | — | — |

**Escalation is not a tool we build.** An earlier draft specified `ask_owner`. It was cut in
build step 3: Claude already has `AskUserQuestion`, and `viewer/questions.py` already owns
the lifecycle — the driven run's question blocks on a permission call, is persisted to
`pending_questions` so it survives an app close or a server restart, is rendered as a card by
the app, and is answered either in the same turn or by resuming the session. A second
escalation path would be exactly the duplicate implementation CLAUDE.md forbids — two
question stores, two UIs, and a guarantee that one of them rots.

What the design actually needed from `ask_owner` was not a channel but a *number*: §12.3's
claim that interruptions fall as autonomy is earned is only checkable if questions are
counted. So the escalation stays native and the counting moves to `questions.record()` — the
one place a question becomes durable, whatever path reached it. It records the question's
*shape* (count, session, host), never its text: `audit_log` is readable by anyone who can
call `/api/org/audit`, and a question body quotes the work. The properties `ask_owner` was
specified to have survive intact — ungated, available to any session at `ic`, never
suppressed by delegation — because they are properties of the built-in tool, which no policy
of ours gates.

**Harman itself holds a strict subset** (§12.1): the whole See-everything tier, plus
`card_create`, `card_assign` and `approval_resolve` — escalation is not in the list because
it is native, not ours to grant. No Orchestrate, no Re-org, no Destructive. A planner that
cannot execute is the constraint that gives every mutation an owner and a transcript.

The exclusion is deliberate: wrapping `fs/*` and `git/*` duplicates Read/Write/Glob/Bash,
which is the duplicate-implementation trap CLAUDE.md forbids. The MCP exposes what Claude
*cannot* do — act on the system running it.

---

## 9. Build order

Each step ships working and is independently reversible.

1. ~~**Principal resolution** — `_Req.principal`, `users.role`, `effective_level()`,
   `PUBLIC_API` → 5 entries (§4).~~ **Done.** Also landed: `self_approves` (the owner's
   own click is the approval, never an agent's), three previously *ungated* column
   writes now behind both gates, and `_org_do` returning the route's own payload so the
   web/mobile clients keep their existing response shapes.
2. ~~**`actions.py` + `execute()`** — migrate the 8 kanban tools onto it; make
   `approval_resolve` re-dispatch stored intents; delete the `kind=="skill"` special case.
   **Proves Red gating actually executes** — the blocker from §0.2.~~ **Done.** Every org
   write is now an intent through one `execute()`; `_org_do` and its closures are gone.
   Three further defects became *reachable* only once approvals executed, and were closed
   in the same step:
   - `orglogic.may_resolve` — the §2A separation-of-duties rail. Inert while approvals did
     nothing; now the difference between a gate and a formality.
   - `db.approval_resolve` resolves an **open** row only. Without it an already-approved
     approval could be re-resolved and its intent run a second time.
   - `actions.intent()` strips credential fields. Routes hand the whole request body over as
     args, and the MCP posts its per-run token in that body — so every queued Red
     action would have parked a live token in `approvals.detail` and `audit_log.target`.

   `skill_promote` sits at `ic`, not `lead`: scope says who may *initiate*, risk says whether
   it lands unattended. An ic's overlapping proposal queues for the owner; it is not refused.
3. ~~**Rename `kanban_mcp.py` → `viewer_mcp.py`**, same transport, add the See-everything
   tier (read-only, `ic`). Ships the "see all sessions" half.~~ **Done.** The rename kept
   history (`git mv`); both call sites — the local `--mcp-config` writer and the SFTP one
   that ships the helper to a remote host — moved together, and the MCP server key went
   `viewerkanban` → `viewer`. The rename note originally claimed no tool allowlist pinned
   the old name; that was wrong — this Mac's `~/.claude/settings.json` allowed
   `mcp__viewerkanban__*`, so from 2026-09-12 to 2026-09-20 every acceptEdits/default run
   routed each `mcp__viewer__*` call through the permission prompt, waited `PERM_TIMEOUT`,
   and was denied (bypass runs were unaffected, which hid it). The fix moved the rule to
   where the tools are registered: `engine._run_settings()` passes
   `permissions.allow: ["mcp__viewer__*"]` in every run's `--settings`, so no machine
   needs a local allow entry. Eight tools became
   nineteen: thirteen read, six write.

   Two properties are load-bearing and easy to lose later:
   - **Read-only is structural, not a promise.** The read tier is GET, and the server's
     write path is POST-only — so a mistake in the tool table cannot turn a read tool into
     a mutation. That is why the tier needs no `_MIN_LEVEL` entries of its own.
   - **`session_read` completes its URL from a model-supplied value**, so the segment is
     percent-quoted; unescaped it could append a query string or traverse to another
     endpoint. Path-addressed tools are listed explicitly (`_PATH_ARG`) so no path is ever
     string-built by accident.

   `ask_owner` was **cut** here — `AskUserQuestion` is native and `questions.py` already
   owns the whole lifecycle (§8). What the design actually needed from it was the
   interruption *count*, now written in `questions.record()` — the single point where a
   question becomes durable, so the number cannot depend on an agent choosing our verb over
   Claude's, and a later caller cannot forget to count. It records the question's *shape*
   (count, session, host) and never its text: `audit_log` is readable by anyone who can
   call `/api/org/audit`, and a question body quotes the work.
4. **Orchestrate tier** — spawn/send/steer/interrupt.
5. **Delegation (§2A) + accountability (§2B)** — `_DELEGATED_KINDS`, the three tests,
   `accountability()` derived from `audit_log`, separation-of-duties rail, `approved:harman`
   marker, kill switch default off. Needs steps 1-2 and real approval history to score
   against, which is why it is not earlier. Ship `accountability` read-only first and
   *watch* the numbers before letting them gate anything.
6. **Skill body in DB + `materialize()`** — fixes the fleet gap and unblocks install.
7. **`observations` + harvest from `session_analysis`.**
8. **The Scribe (§5A)** — seed in `bootstrap.py`, `distill` card kind, system prompt.
   Depends on 5/6/7 and is the piece with a self-amplification risk.
9. **`capabilities.py` + `capability_probe` (§7A)** — capability block on the hosts
   entry, `resolve()`, `contextLimit` from `max_model_len`, de-machine `config.py:67-87`.
   Then `pyproject.toml` + extend `bootstrap.py`, and run the clean-box acceptance test.
10. **The Harman session (§12)** — seed it pinned in `bootstrap.py`, restrict Harman's
    `_MIN_LEVEL` subset, the interruption digest, the system prompt. **Last**, because
    every constraint in §12 is enforced by machinery from 1-9; shipping the prompt first
    would be asking a prompt to do a permission table's job.

Steps 1-2 are prerequisites for everything and contain all the real risk. Step 5 is where
autonomy is granted — it should not ship until the audit trail from 1-4 is trusted. Step
10 is the only one Ram interacts with directly, and it is deliberately the last thing
built rather than the first.

---

## 12. The Harman session — Ram's only interface

Ram: *"a single prefixed Harman chat session pinned to the top by default, my only
interface to Harman. Harman doesn't do anything on its own but reason, plan, create tasks
and delegate — an interface, a second brain, where I give only real-world resources and
decisions. Everything else is handled responsibly, but not so intrusive as to come to me
all the time for silly things. The user's time is precious."*

This is the product. Everything above is what makes it possible.

### 12.1 Harman plans; Harman does not execute

This narrows §2A and §8 and is the constraint the rest of the section hangs on.

Harman holds tools from **See-everything**, plus exactly three verbs: `card_create`,
`card_assign` and `approval_resolve` (bounded by §2B). It holds **nothing** from
Orchestrate, Re-org or Destructive. Not by convention — by `_MIN_LEVEL`, the same
deny-by-default table as every other principal. Escalation is not in the list because it is
not ours to grant: `AskUserQuestion` is native and ungated for every session.

Why this is a real constraint and not decoration:

- **Every mutation gets an owner.** Work happens under an employee, on a card, with a
  transcript. There is no "Harman just did it" with nothing to review or revert.
- **It preserves separation of duties at the top.** §2A forbids approving your own
  escalation. If Harman both created and executed work, its `approval_resolve` power
  would let it authorise itself through a second door.
- **It makes the interruption budget honest.** A planner that cannot act has nothing to
  hide; its entire output is cards, questions and delegations that Ram can see.

Harman's ability to *spawn* is therefore indirect: it creates a card; the existing
planner (`plan_assignments` → `_spawn_employee_session`, `orchestrator.py:82-189`)
assigns and spawns it. That path already carries budget, `HARD_CAP`, the in-progress
guard and audit. **This is the same mechanism as the Scribe (§5A)** — one way work
starts, not two.

### 12.2 One session, pinned, prefixed

Not a new UI surface — a seeded session that sorts first.

- **Seeded in `bootstrap.py`** beside the existing employee seeds, with a fixed id so it
  is the same session on every install and idempotent to re-run.
- **Pinned** via a `pinned` flag in `SESSION_META`, which the list handlers already
  overlay (`routes/sessions.py:906-911` already does exactly this for `archived` and
  `favorite`). Sort becomes `(not pinned, -modified)` — one key change, no new endpoint.
  The mobile list sorts by `modified` today (`ChatsScreen.tsx:241`); it gets the same key.
- **Prefixed** title so it is unmistakable in the list.
- **Never archivable, never deletable.** `session_delete` on the pinned id is refused
  outright — not queued as Red. Ram's interface is not a thing that can be approved away.
- **It is a normal session.** Same transcript, same MCP, same audit. If it were special
  it would drift from the code path everything else uses.
- **It addresses the owner, not "Ram".** The session belongs to whoever holds
  `users.role == "owner"` on this install (§7.2). Harman's prompt resolves that name at
  spawn; nothing in source knows it.

Ram keeps every other session. This is the *default* interface, not a cage — the pin
makes Harman first, not exclusive.

### 12.3 What reaches Ram — the interruption budget

*"Not so intrusive to come to me all the time for silly things"* is a testable
constraint, not a tone. Four rules, in order:

1. **Nothing routine.** §2A + §2B already absorb precedented, recoverable, contained
   approvals. Interruption is the exception path.
2. **Only these four categories may interrupt:**
   - **Real-world resources** — money, credentials, hardware, an account, physical
     access. Harman cannot obtain these; asking is not a failure of autonomy.
     (This is exactly `_RESERVED_KINDS = {secret, money}` — already built.)
   - **Genuine preference** — two defensible paths where the choice is taste, not
     correctness. Raised by the agent via `AskUserQuestion`; **no table can classify this**,
     which is why it is a tool the model reaches for and not a policy rule.
   - **First-of-kind** — §2B's `n < N_MIN`. Asked once, then never again for that kind.
     Each interruption permanently reduces future ones.
   - **A self-approval that failed** — reported *after*, not asked before.
3. **Batched, not streamed.** Non-urgent items accumulate into one digest rather than N
   pushes. Ten questions in one message costs a fraction of ten interruptions.
4. **Every question carries a recommendation and a default.** Never "what should I do?" —
   always "I plan X because Y; say no to change it." Ram's cheapest possible action is
   silence, and silence must be safe.

**Measured, not asserted.** Interruptions/day is derived from `audit_log` — `ask_owner`
rows (written by `questions.record()` when a native `AskUserQuestion` is persisted, so the
count does not depend on an agent choosing our verb over Claude's) plus non-delegated
`approval_resolve` rows — and shown on the Harman session. If it does not fall as §2B scores
rise, the design is wrong and the number will say so. Without this, "non-intrusive" is an
aspiration nobody can check.

The honest failure mode, stated plainly: **an interruption budget optimises for silence,
and silence is also what a system looks like when it is quietly doing the wrong thing.**
The counterweights are §2A's rule that failures always surface, `AskUserQuestion` being
native and ungated so any session can escalate past Harman, and §11.5's review surface.
Delegation without a review surface is indistinguishable from having no gate at all.

### 12.4 Reading order

Harman's system prompt is the second genuinely new artifact (after the Scribe's), and it
encodes exactly this section: reason, plan, delegate, never execute; ask only in the four
categories; always recommend and default; batch the rest.

It ships **last** — after step 9 — because a planner is only as good as the tools it can
delegate to, and every constraint here is enforced by machinery from steps 1-9 rather
than by the prompt. A prompt that says "don't execute" while holding destructive tools is
theatre; `_MIN_LEVEL` is the actual boundary.

---

## 13. Not building (and why)

- **A skill router/selector.** Claude Code matches on description; materialization is the
  routing lever. A second selector would be a parallel code path for one capability.
- **A background distiller thread.** The Scribe is a card on the existing board (§5A);
  a thread would be a second unaudited execution path for the same work.
- **A new "Harman loop".** `harman_tick()` exists and is wired (`engine.py:198`). The
  distiller is a new card kind, not a new loop.
- **A separate Harman UI.** §12.2 is a seeded, pinned session on the existing list — a
  bespoke surface would be a second chat implementation to keep in sync.
- **Widening Green to reduce interruptions.** §2A delegates approvals instead; the Red
  classification stays intact so the audit trail keeps meaning.
- **A global trust score.** §2B scores `(principal, action_kind)` pairs. One number for
  "how much do we trust Harman" lets competence at cheap actions pay for expensive ones.
- **A service registry / discovery daemon.** §7A adds a field to the hosts file that
  already exists; a registry would be new infrastructure for a fleet of single digits.
- **Wrapping `fs/*` / `git/*`.** Duplicates native tools.
- **Semantic skill dedupe.** Name-matching stays for now; noted as a known limit (§5).
- **Per-user tenancy on sessions/cards.** Layered RBAC caps *authority*, not *visibility*.
  If a `viewer` human must be blind to other people's sessions, that is a separate change —
  say so and it gets designed, not smuggled in.

---

## 14. Open, needs Ram

1. **Distillation threshold** — how many observations before a skill candidate is proposed?
   Too low = noise in the library; too high = it never learns. Start at 3 within one concern?
2. **Does a distilled skill auto-promote or always queue?** §5 keeps the existing gate
   (novel → active, overlap → approval). With automatic harvesting the volume is much
   higher than today's voluntary path — auto-promotion may need to become opt-in.
3. **Cross-host session visibility** — `session_list` spanning every host means an agent on
   one box reads transcripts from another. Correct for "see everything"; confirm that is
   intended for *remote* hosts too, not just local.
4. **Delegation scope (§2A).** `_DELEGATED_KINDS = {infra, destructive}` with `secret` and
   `money` always reserved — is `destructive` too far for a first cut? A narrower start
   (`infra` only) still removes most interruptions and can widen once the
   `approved:harman` audit trail has been read a few times.
5. **How does Ram see what was approved without him?** A digest (daily push, or a Board
   column) — or only on request? Delegation without a review surface is indistinguishable
   from no gate at all. §12.3 assumes a digest; confirm the channel (push vs. the pinned
   session itself).
6. **Accountability constants (§2B).** `TAU=0.8`, `N_MIN=3`, `HALF_LIFE=30d`, `λ=3`,
   `μ=2` are reasoned starting points, not measured ones. They should be tuned from the
   first month of real audit data rather than defended as chosen.
7. **Does the pinned Harman session survive `apply_default`?** `/api/providers/apply-default`
   (`routes/providers.py:87`) rewrites the provider on *every* session. Harman's own
   provider probably should be exempt — otherwise one bulk change can point Ram's sole
   interface at an unreachable engine.


