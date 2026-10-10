// api.ts — the single transport layer between the UI and the Python server.
// Ported from the vanilla api.js: endpoint URLs + host-threading live here.
// `host` is set once (by the store) and injected centrally.

import type { NoteGraph } from "./noteLinks"
import type { NoteExportFormat } from "./notes"
import type { Provider, HarmanConfig, LoopControl, LoopMode, MapLevel, MapView, OrgProject, BoardColumn, Card, CardComment, CardDep, CardFilter, Note, NoteComment, NoteCommentSort, NoteFilter, NoteKind, Queued, SessionDetail, SessionMeta, OpenDecision, Drive, IntakeChannel, IntegrationsView, InboxFilter, InboxMessage, MarketPage } from "./types"
import type { HarmanLevel, PermissionPolicy, TrustWrite } from "./trust"
import type { AIConfig, AIScope, AISelection, ModelDiscovery } from "./aiSelection"
import type { KeyAction } from "./providerModels"
import { auditPath, parseAuditPage, type AuditFilter } from "./audit"
import type { RelayOffer, RelayStatus } from "./pairLink"

type Body = Record<string, unknown>

class ApiClient {
  host = "local"
  agent = "claude"
  /** Called when any request returns 401 (missing/invalid access token). */
  onUnauthorized: (() => void) | null = null

  setHost(h: string) {
    this.host = h || "local"
  }
  setAgent(a: string) {
    this.agent = a || "claude"
  }

  /** Surface auth failures to the UI (show the token gate) before callers try
   * to JSON.parse the 401 error page. */
  private tap(res: Response): Response {
    if (res.status === 401) this.onUnauthorized?.()
    return res
  }

  private qs(sep = "&"): string {
    return this.host && this.host !== "local"
      ? `${sep}host=${encodeURIComponent(this.host)}`
      : ""
  }
  /** Non-default agent as a query fragment (host stays separate). */
  private ag(): string {
    return this.agent && this.agent !== "claude" ? `&agent=${encodeURIComponent(this.agent)}` : ""
  }
  /** Inject host into a POST body exactly where the vanilla code did. */
  private wh(body: Body): Body {
    return { ...body, host: this.host }
  }
  /** Host + current agent — for session/MCP ops that dispatch per agent. NOT
   * for login/install, which target an explicit agent that must not be overridden. */
  private wha(body: Body): Body {
    return { ...body, host: this.host, agent: this.agent }
  }

  // ---- low-level ----
  async getJSON<T = any>(path: string): Promise<T> {
    return (this.tap(await fetch(path))).json()
  }
  getRes(path: string): Promise<Response> {
    return fetch(path).then((r) => this.tap(r))
  }
  postRes(path: string, body?: Body): Promise<Response> {
    return fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    }).then((r) => this.tap(r))
  }
  async postJSON<T = any>(path: string, body?: Body): Promise<T> {
    return (await this.postRes(path, body)).json()
  }
  /** Like getJSON/postJSON but a non-2xx response THROWS an Error carrying
   *  `status` and the server's `error` text, for callers that branch on the
   *  status code (400 invalid, 409 stale revision) instead of reading an
   *  `error` field off the body. */
  private async strict<T>(res: Response): Promise<T> {
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw Object.assign(new Error(data?.error || data?.reason || `HTTP ${res.status}`), { status: res.status })
    }
    return data as T
  }
  private async getStrict<T>(path: string): Promise<T> {
    return this.strict<T>(this.tap(await fetch(path)))
  }
  private async postStrict<T>(path: string, body?: Body): Promise<T> {
    return this.strict<T>(await this.postRes(path, body))
  }

  // ---- agents ----
  agents() {
    return this.getJSON("/api/agents" + this.qs("?"))
  }
  agentsInstall(body: Body) {
    return this.postRes("/api/agents/install", this.wh(body))
  }
  agentLoginStart(body: Body) {
    return this.postJSON("/api/agents/login/start", this.wh(body))
  }
  agentLoginPoll(agent: string) {
    return this.getJSON(`/api/agents/login/poll?agent=${encodeURIComponent(agent)}` + this.qs())
  }
  agentLoginSubmit(body: Body) {
    return this.postJSON("/api/agents/login/submit", this.wh(body))
  }
  agentLoginCancel(body: Body) {
    return this.postRes("/api/agents/login/cancel", this.wh(body))
  }

  // ---- hosts ----
  hosts() {
    return this.getJSON("/api/hosts")
  }
  hostsTest(cfg: Body) {
    return this.postJSON("/api/hosts/test", cfg)
  }
  hostsSave(cfg: Body) {
    return this.postJSON("/api/hosts/save", cfg)
  }
  hostsDelete(id: string) {
    return this.postRes("/api/hosts/delete", { id })
  }
  // Per-host env vars (secrets): list returns KEYS only; value reveals one on demand.
  env(host: string) {
    return this.getJSON(`/api/env?host=${encodeURIComponent(host)}`)
  }
  envValue(host: string, key: string) {
    return this.getJSON(`/api/env/value?host=${encodeURIComponent(host)}&key=${encodeURIComponent(key)}`)
  }
  envSet(host: string, key: string, value: string) {
    return this.postJSON("/api/env/set", { host, key, value })
  }
  envUnset(host: string, key: string) {
    return this.postJSON("/api/env/unset", { host, key })
  }

  // ---- sessions list / read ----
  sessions() {
    return this.getJSON("/api/sessions?_=1" + this.qs() + this.ag())
  }
  sessionReadTail(path: string, tail: number) {
    return this.getRes(`/api/session/${path}?tail=${tail}` + this.qs() + this.ag())
  }
  sessionReadFrom(path: string, from: number) {
    return this.getRes(`/api/session/${path}?from=${from}` + this.qs() + this.ag())
  }
  sessionReadBefore(path: string, before: number, lines: number) {
    return this.getRes(`/api/session/${path}?before=${before}&lines=${lines}` + this.qs() + this.ag())
  }
  resolve(id: string) {
    return this.getJSON(`/api/resolve?id=${id}` + this.qs())
  }
  // Mark a session read for this reader (advances the server-side unread cursor).
  // Fire-and-forget from the UI; the next list refresh reflects unread=false.
  sessionSeen(path: string) {
    return this.postRes("/api/session/seen", this.wh({ session: path }))
  }
  projects() {
    return this.getJSON("/api/projects" + this.qs("?"))
  }
  /** The cross-session decision queue (card #60): every open durable
   *  question/plan + live tool approval, oldest first, with a total count.
   *  Read-only — deciding an item goes through /api/chat/question/answer,
   *  /api/chat/plan/decide or /api/chat/permission/decide. */
  openDecisions() {
    // getRes (not getJSON): a 404 is a meaningful signal — the server predates
    // the queue route (restart pending) — and the band hides itself on it
    // instead of erroring on every board.
    return this.getRes("/api/decisions/open").then(async (r) => {
      if (!r.ok) throw Object.assign(new Error(`decisions queue unavailable (${r.status})`), { status: r.status })
      return r.json() as Promise<{ count: number; decisions: OpenDecision[] }>
    })
  }

  // ---- org / Kanban (project-scoped board) ----
  /** Harman orchestrator config — the single server-side source of truth for
   *  the master automation switch. Read on both apps; writable from the web
   *  Profile tab and the mobile Profile screen (they mirror each other). */
  orgHarman() {
    return this.getJSON<HarmanConfig>("/api/org/harman")
  }
  /** Flip the master automation switch. Turning it ON is a Red action — a
   *  caller who can't self-approve gets an approval back, not the config —
   *  hence the `| Queued` union. */
  orgSetHarman(patch: Partial<HarmanConfig>) {
    return this.postJSON<HarmanConfig | Queued>("/api/org/harman", patch)
  }
  /** Loop-firing mode — which loop origins may run, orthogonal to automation.
   *  Green (manager scope, never queues): the write returns the applied config. */
  orgLoopControl() {
    return this.getJSON<LoopControl>("/api/org/loop-control")
  }
  orgSetLoopControl(mode: LoopMode) {
    return this.postJSON<LoopControl>("/api/org/loop-control", { mode })
  }
  /** The global system-awareness preamble prepended to every session's system
   *  prompt. Read is open; the write is manager-scoped AND Red — a non-owner
   *  caller gets an approval back, not the value, hence the `| Queued` union. */
  orgSystemPreamble() {
    return this.getJSON<{ preamble: string }>("/api/org/system-preamble")
  }
  orgSetSystemPreamble(preamble: string) {
    return this.postJSON<{ preamble: string } | Queued>("/api/org/system-preamble", { preamble })
  }
  /** The activity feed, validated against the display-v1 contract before any of
   *  it is rendered — a raw or older-shaped response throws, never displays. */
  async orgAudit(result: AuditFilter = "all", before?: number) {
    return parseAuditPage(await this.getStrict(auditPath(result, before)), before)
  }
  /** Find-or-create the org project for a (host, cwd) directory → the board it maps to. */
  orgProjectForCwd(body: { host: string; cwd: string; name?: string }) {
    return this.postJSON<OrgProject>("/api/org/project-for-cwd", body)
  }
  /** One level of the project's code Map (the Map lens). Throws the server's
   *  sentence (remote project, not a code folder) for the dialog to show. */
  orgMap(projectId: number, level: MapLevel, path = "") {
    const p = new URLSearchParams({ project: String(projectId), level, path })
    return this.getStrict<MapView>(`/api/org/map?${p}`)
  }
  orgBoard(projectId: number) {
    return this.getJSON<{ columns: BoardColumn[] }>(`/api/org/board?project=${projectId}`)
  }
  orgCards(filter: CardFilter = {}) {
    const p = new URLSearchParams()
    if (filter.session) p.set("session", filter.session)
    if (filter.project != null) p.set("project", String(filter.project))
    const q = p.toString()
    return this.getJSON<{ cards: Card[] }>(`/api/org/cards${q ? "?" + q : ""}`)
  }
  orgCreateCard(body: { title: string; body?: string; column_id?: number; project_id?: number; session?: string; position?: number }) {
    return this.postJSON<Card>("/api/org/cards", body)
  }
  orgMoveCard(body: { card_id: number; column_id: number; position: number }) {
    return this.postJSON<Card>("/api/org/cards/move", body)
  }
  orgUpdateCard(body: { card_id: number; title?: string; body?: string; column_id?: number; position?: number }) {
    return this.postJSON<Card>("/api/org/cards/update", body)
  }
  // `card_delete` is Red (viewer/orglogic): a caller who can't self-approve gets
  // an approval back, not a deletion — hence the union.
  orgDeleteCard(cardId: number) {
    return this.postJSON<{ deleted?: boolean } | Queued>("/api/org/cards/delete", { card_id: cardId })
  }
  orgNotes(filter: NoteFilter = {}) {
    const p = new URLSearchParams()
    if (filter.session) p.set("session", filter.session)
    if (filter.project != null) p.set("project", String(filter.project))
    if (filter.archived) p.set("archived", "1")
    const q = p.toString()
    return this.getJSON<{ notes: Note[] }>(`/api/org/notes${q ? "?" + q : ""}`)
  }
  orgCreateNote(body: { title: string; body?: string; kind?: NoteKind; project_id?: number; session?: string; pinned?: boolean }) {
    return this.postJSON<Note>("/api/org/notes", body)
  }
  orgUpdateNote(body: { note_id: number; title?: string; body?: string; kind?: NoteKind; pinned?: boolean; archived?: boolean }) {
    // `relinked`: on a rename, how many notes had their [[links]] rewritten.
    return this.postJSON<Note & { relinked?: number }>("/api/org/notes/update", body)
  }
  /** The linked-notes graph of a project (both shelves): nodes, [[link]]
   *  edges, ghosts, tag counts and the title index links resolve through. */
  orgNotesGraph(project: number) {
    return this.getJSON<NoteGraph>(`/api/org/notes/graph?project=${project}`)
  }
  /** URL of the project's notes as an Obsidian vault (.zip of .md files). */
  orgNotesExportUrl(project: number): string {
    return `/api/org/notes/export?project=${project}`
  }
  /** URL of ONE note as a file (viewer/noteexport.py): Markdown, Word or PDF. */
  orgNoteExportUrl(id: number, format: NoteExportFormat): string {
    return `/api/org/note/export?id=${id}&format=${format}`
  }
  /** A note's discussion thread, nested and sorted server-side. */
  orgNoteComments(noteId: number, sort: NoteCommentSort = "best") {
    return this.getJSON<{ comments: NoteComment[]; count: number }>(`/api/org/note_comments?note_id=${noteId}&sort=${sort}`)
  }
  orgNoteComment(body: { note_id: number; body: string; parent_id?: number | null }) {
    return this.postJSON<NoteComment>("/api/org/note_comment", body)
  }
  /** value: 1 up, -1 down, 0 withdraws the reader's vote. */
  orgNoteVote(commentId: number, value: -1 | 0 | 1) {
    return this.postJSON<{ comment_id: number; my_vote: number; score: number }>("/api/org/note_vote", { comment_id: commentId, value })
  }
  // `note_delete` is Red like card_delete: an agent's delete queues for the owner.
  orgDeleteNote(noteId: number) {
    return this.postJSON<{ deleted?: boolean } | Queued>("/api/org/notes/delete", { note_id: noteId })
  }
  // ---- Inbox (the message ledger; decision rows ride in it — the deciding
  // tap stays on the per-session routes, this is the delivery surface) ----
  inboxList(filter: InboxFilter = {}) {
    const p = new URLSearchParams()
    if (filter.session) p.set("session", filter.session)
    if (filter.project != null) p.set("project", String(filter.project))
    if (filter.kind) p.set("kind", filter.kind)
    if (filter.unread_only) p.set("unread_only", "1")
    if (filter.archived) p.set("archived", "1")
    const q = p.toString()
    return this.getJSON<{
      messages: InboxMessage[]
      unread?: number
      queue?: { count: number; items: InboxMessage[] }
    }>(`/api/inbox${q ? "?" + q : ""}`)
  }
  inboxRead(id: number) {
    return this.postJSON<{ ok?: boolean }>("/api/inbox/read", { id })
  }
  inboxSnooze(id: number, hours: number) {
    return this.postJSON<{ ok?: boolean; snoozed_until?: number }>("/api/inbox/snooze", { id, hours })
  }
  /** The sender is stamped by the server from the session's identity (an MCP
   *  subprocess can never impersonate one), so the body carries only the
   *  destination. Green at ic — an agent's message runs immediately. */
  inboxSend(body: { to: string; body: string; in_reply_to?: number }) {
    return this.postJSON<InboxMessage>("/api/inbox/send", body)
  }

  /** Decide an org (Red) approval; approving runs the queued action. Throws
   *  with `status`: 403 when the caller raised it (separation of duties),
   *  404 when it is gone or already decided. */
  orgResolveApproval(id: number, resolution: "approved" | "denied") {
    return this.postStrict<{ id: number; status: string; result?: { error?: string } }>(
      "/api/org/approvals/resolve", { id, resolution })
  }

  // A card with its full comment thread and dependency edges — the discussion
  // and the dual-control blocker state between the owner and the card's session.
  orgCard(id: number) {
    return this.getJSON<{ card: Card; comments: CardComment[]; dependencies: CardDep[]; columns: BoardColumn[] }>(`/api/org/card?id=${id}`)
  }
  orgAddCardComment(body: { card_id: number; body: string }) {
    return this.postJSON<CardComment>("/api/org/card_comment", body)
  }
  orgCardDeps(cardId: number) {
    return this.getJSON<{ dependencies: CardDep[] }>(`/api/org/card_deps?card_id=${cardId}`)
  }
  orgAddCardDep(body: { card_id: number; depends_on: number }) {
    return this.postJSON<CardDep>("/api/org/card_dep_add", body)
  }
  orgRemoveCardDep(body: { card_id: number; depends_on: number }) {
    return this.postJSON<{ removed?: boolean }>("/api/org/card_dep_remove", body)
  }
  orgCreateColumn(body: { project_id: number; name: string; position?: number }) {
    return this.postJSON<BoardColumn>("/api/org/columns", body)
  }
  orgUpdateColumn(body: { id: number; name?: string; position?: number }) {
    return this.postJSON<BoardColumn>("/api/org/columns/update", body)
  }
  orgDeleteColumn(id: number) {
    return this.postJSON<{ deleted?: boolean }>("/api/org/columns/delete", { id })
  }

  // ---- git (repo picker / clone / status) ----
  gitRepos() {
    return this.getJSON("/api/git/repos" + this.qs("?"))
  }
  gitStatus(cwd: string) {
    return this.getJSON(`/api/git/status?cwd=${encodeURIComponent(cwd)}` + this.qs())
  }
  /** Starts a background clone → {job}; poll gitCloneStatus until !running. */
  gitClone(body: Body) {
    return this.postRes("/api/git/clone", this.wh(body))
  }
  gitCloneStatus(id: string) {
    return this.getJSON(`/api/git/clone/status?id=${encodeURIComponent(id)}`)
  }

  // ---- model providers (global library — NOT host-scoped) ----
  /** The saved custom-endpoint presets. apiKey is never returned. */
  providers() {
    return this.getJSON<{ providers: Provider[] }>("/api/providers")
  }
  /** Create (omit id) or update a connection. apiKeyAction keep|replace|remove
   *  (replace sends apiKey). modelOverrides is the full {model: tokens} map of
   *  owner-set context windows; it replaces the previous one. */
  providerSave(body: {
    id?: string
    name: string
    baseUrl: string
    model: string
    apiKeyAction: KeyAction
    apiKey?: string
    modelOverrides: Record<string, number>
  }) {
    return this.postStrict<Provider>("/api/providers", body)
  }
  providerDelete(id: string) {
    return this.postJSON<{ deleted?: boolean }>("/api/providers/delete", { id })
  }
  /** A saved connection's models (the server learns their limits). */
  providerModels(q: { id: string }) {
    return this.getJSON<ModelDiscovery & { error?: string }>("/api/providers/models?" + new URLSearchParams(q).toString())
  }
  /** Probe a draft connection. POST, so a typed key never lands in a URL. */
  providerDraftModels(draft: { id?: string; baseUrl: string; apiKeyAction: KeyAction; apiKey?: string }) {
    return this.postStrict<ModelDiscovery>("/api/providers/models", draft)
  }

  // ---- AI selection (server-owned; viewer/ai.py) ----
  private aiPath(scope: AIScope) {
    return scope.id ? "/api/session/ai" : "/api/ai/defaults"
  }
  /** The stored selection + capabilities for a scope. Pass `draft` to get the
   *  capabilities for a provider/mode the user is trying, not the stored one. */
  aiConfig(scope: AIScope, draft?: AISelection) {
    const params: Record<string, string> = { host: scope.host, agent: scope.agent || "claude" }
    if (scope.id) params.id = scope.id
    if (draft) Object.assign(params, { provider: draft.provider, convMode: draft.convMode })
    return this.getStrict<AIConfig>(this.aiPath(scope) + "?" + new URLSearchParams(params).toString())
  }
  /** Compare-and-swap save: 400 on an invalid selection, 409 when `revision`
   *  is stale — both surface as thrown errors carrying `status`. */
  aiSave(scope: AIScope, revision: number, selection: AISelection) {
    return this.postStrict<AIConfig>(this.aiPath(scope), {
      ...scope,
      agent: scope.agent || "claude",
      revision,
      selection,
    })
  }

  // ---- session lifecycle ----
  newSession(body: Body) {
    return this.postRes("/api/new-session", this.wha(body))
  }
  forkSession(body: Body) {
    return this.postRes("/api/session/fork", this.wha(body))
  }
  restoreSession(body: Body) {
    return this.postRes("/api/session/restore", this.wha(body))
  }
  deleteSession(body: Body) {
    return this.postRes("/api/session/delete", this.wha(body))
  }
  renameSession(body: Body) {
    return this.postRes("/api/session/rename", this.wha(body))
  }

  // ---- session metadata / summary / analysis ----
  sessionMeta(path: string) {
    return this.getJSON<SessionMeta>(`/api/session-meta?session=${encodeURIComponent(path)}` + this.qs())
  }
  sessionMetaSave(body: Body) {
    return this.postRes("/api/session-meta", body)
  }
  sessionSummary(path: string) {
    return this.getJSON(`/api/session-summary?session=${encodeURIComponent(path)}` + this.qs())
  }
  /** One composed view of ANY session — meta + capabilities + summary + live run
   *  flag in a single call (the same document the session_detail MCP tool wraps).
   *  Lets the list expand a peer's skills·MCP·cwd·model in place without opening it. */
  sessionDetail(path: string) {
    return this.getJSON<SessionDetail>(
      `/api/session-detail?session=${encodeURIComponent(path)}` + this.qs() + this.ag()
    )
  }
  /** A chat's Trust (lib/trust.ts). Red: the owner's own tap applies; anyone
   *  else's ask queues. `session` is the id sessionMeta returned. */
  sessionModeSet(session: string, mode: PermissionPolicy) {
    return this.postJSON<TrustWrite>("/api/session/mode", { for_session: session, mode })
  }
  /** "" clears the chat's override back to the level of the agent it was started from. */
  sessionLevelSet(session: string, level: HarmanLevel | "") {
    return this.postJSON<TrustWrite>("/api/session/level", { for_session: session, level })
  }
  sessionAnalysis(path: string, refresh?: boolean) {
    return this.getJSON(
      `/api/session-analysis?session=${encodeURIComponent(path)}` +
        this.qs() +
        (refresh ? "&refresh=1" : "")
    )
  }

  // ---- chat ----
  chat(body: Body) {
    return this.postRes("/api/chat", this.wh(body))
  }
  chatSteer(body: Body) {
    return this.postRes("/api/chat/steer", this.wh(body))
  }
  chatInterrupt(body: Body) {
    return this.postRes("/api/chat/interrupt", body)
  }
  chatStatus(sessionId: string) {
    return this.getJSON(`/api/chat/status?id=${sessionId}`)
  }
  chatPermissionDecide(body: Body) {
    return this.postRes("/api/chat/permission/decide", body)
  }
  // Answer a parked AskUserQuestion (async). The server unblocks the waiting call
  // or resumes the session with the composed answer — NOT a queued chat message.
  chatQuestionAnswer(body: Body) {
    return this.postRes("/api/chat/question/answer", this.wh(body))
  }
  chatQueueRemove(body: Body) {
    return this.postRes("/api/chat/queue/remove", body)
  }
  // Approve or send changes back on a live (blocked) ExitPlanMode. Same-turn:
  // the run is parked waiting on this, so approving resumes it rather than
  // starting a new one.
  chatPlanDecide(body: Body) {
    return this.postRes("/api/chat/plan/decide", body)
  }

  // ---- loops ----
  loops(sessionId: string) {
    return this.getJSON(`/api/loops?session=${sessionId}`)
  }
  loopsCreate(body: Body) {
    return this.postRes("/api/loops", body)
  }
  loopsEdit(body: Body) {
    return this.postRes("/api/loops/edit", body)
  }
  loopsDelete(id: string) {
    return this.postRes("/api/loops/delete", { id })
  }

  // ---- capabilities: skills + MCP ----
  commands(qs: string) {
    return this.getJSON("/api/commands" + qs)
  }
  capabilities(qs: string) {
    return this.getJSON("/api/capabilities" + (qs ? "?" + qs : ""))
  }
  /** Public liveness + version probe. Not under /api/ (needs no auth), takes no
   *  host/agent — it reports THIS server's own release. `version` is the code on
   *  disk; `db_version` is what the DB was last stamped with (they differ only
   *  during a half-applied upgrade). Used to show the running version in the UI. */
  health() {
    return this.getJSON<{
      ok: boolean
      version: string
      schema_version: number
      db_ok: boolean
      db_version: string | null
      db_schema: number | null
    }>("/healthz")
  }
  skill(path: string) {
    return this.getJSON(`/api/skill?path=${encodeURIComponent(path)}`)
  }
  skillSave(body: Body) {
    return this.postRes("/api/skill/save", body)
  }
  skillDelete(body: Body) {
    return this.postRes("/api/skill/delete", body)
  }
  mcpSave(body: Body) {
    return this.postRes("/api/mcp/save", this.wha(body))
  }
  // Marketplace: the server rebuilds every install from the source's own record;
  // the client names an entry id, never a command. Installs land on this machine.
  marketMcp(q: string, cursor?: string) {
    return this.getStrict<MarketPage>(`/api/market/mcp?${new URLSearchParams({ q, ...(cursor ? { cursor } : {}) })}`)
  }
  marketSkills(q: string) {
    return this.getStrict<MarketPage>(`/api/market/skills?${new URLSearchParams({ q })}`)
  }
  marketMcpInstall(body: { id: string; values: Record<string, string>; scope: "global" | "project"; session?: string }) {
    return this.postStrict<{ installed: string; scope: string }>("/api/market/mcp/install", body)
  }
  marketSkillInstall(body: { id: string; scope: "user" | "project"; session?: string }) {
    return this.postStrict<{ installed: string; scope: string }>("/api/market/skill/install", body)
  }
  mcpSaveBrowserAllAgents(body: Body) {
    return this.postRes("/api/agents/mcp/browser", this.wh(body))
  }
  mcpDelete(body: Body) {
    return this.postRes("/api/mcp/delete", this.wha(body))
  }

  // Resolve the shell command to resume a Copilot session interactively (host-aware).
  copilotInteractive(session: string) {
    return this.getJSON<{ cmd?: string; error?: string }>(
      `/api/copilot-interactive?session=${encodeURIComponent(session)}` + this.qs()
    )
  }

  // ---- filesystem (local / SSH host / cloud drive) ----
  // A file op targets exactly one location: the current host (threaded like
  // every other request) or a cloud drive, named per call by the file browser.
  // The drive is deliberately NOT client-wide state: it is a choice of the
  // file browser alone and must never ride along on chat/session requests.
  private fsq(drive?: string): string {
    return drive ? `&drive=${encodeURIComponent(drive)}` : this.qs()
  }
  private fsBody(body: Body, drive?: string): Body {
    return drive ? { ...body, drive } : this.wh(body)
  }
  fs(path: string, hidden?: boolean, drive?: string) {
    return this.getJSON(
      `/api/fs?path=${encodeURIComponent(path)}&hidden=${hidden ? 1 : 0}` + this.fsq(drive)
    )
  }
  fsMkdir(body: Body, drive?: string) {
    return this.postRes("/api/fs/mkdir", this.fsBody(body, drive))
  }
  fsDelete(body: Body, drive?: string) {
    return this.postRes("/api/fs/delete", this.fsBody(body, drive))
  }
  fsDownload(path: string, drive?: string): string {
    return `/api/fs/download?path=${encodeURIComponent(path)}` + this.fsq(drive)
  }
  /** URL that streams a single .zip bundling `names` inside directory `path`. */
  fsDownloadZip(path: string, names: string[], archive?: string, drive?: string): string {
    const q = new URLSearchParams({ path })
    q.set("names", JSON.stringify(names))
    if (archive) q.set("archive", archive)
    if (drive) q.set("drive", drive)
    else if (this.host && this.host !== "local") q.set("host", this.host)
    return "/api/fs/download-zip?" + q.toString()
  }
  fsUpload(path: string, files: File[], drive?: string): Promise<Response> {
    const form = new FormData()
    files.forEach(f => form.append("files", f))
    return fetch(`/api/fs/upload?path=${encodeURIComponent(path)}` + this.fsq(drive), {
      method: "POST",
      body: form,
    })
  }
  fsRename(body: Body, drive?: string) {
    return this.postRes("/api/fs/rename", this.fsBody(body, drive))
  }
  fsCompress(body: Body, drive?: string) {
    return this.postRes("/api/fs/compress", this.fsBody(body, drive))
  }

  // ---- cloud drives (the file browser's third location) ----
  /** Every drive the location picker can offer (sanitized — no tokens) plus the
   *  vendors a NEW drive may be created for. */
  drives() {
    return this.getJSON<{ drives: Drive[]; vendors: string[] }>("/api/drives")
  }
  /** Create an empty drive row to then connect via the consent flow. */
  driveCreate(body: { label: string; kind: string }) {
    return this.postJSON<{ drive: Drive }>("/api/drives", body)
  }
  /** Remove a drive (and its stored tokens). */
  driveDelete(id: string) {
    return this.postJSON<{ ok?: boolean } | { error?: string }>("/api/drives/delete", { drive: id })
  }
  /** Begin the hosted consent flow for a drive → the vendor URL to open + the
   *  pending handle to poll with driveOAuthStatus(). The vendor redirects the
   *  browser back to this server's /api/drive/oauth/callback, which finishes
   *  the exchange; the poll is how this tab learns the result. */
  driveOAuthStart(drive: string) {
    return this.postJSON<{ url: string; pending: string; redirect_uri: string } | { error?: string }>(
      "/api/drive/oauth/start", { drive }
    )
  }
  /** Poll an in-flight consent flow until authorized/failed/expired. */
  driveOAuthStatus(pending: string) {
    return this.getJSON<{ pending: string; status: "waiting" | "authorized" | "failed" | "expired"; error?: string }>(
      `/api/drive/oauth/status?pending=${encodeURIComponent(pending)}`
    )
  }

  // ---- intake channels: outside doors onto a board (viewer/intake.py) ----
  orgProjects() {
    return this.getJSON<{ projects: OrgProject[] }>("/api/org/projects")
  }
  intakeList() {
    return this.getJSON<{ channels: IntakeChannel[] }>("/api/org/intake")
  }
  /** Opening a door is Red: the owner self-approves and gets the token back once. */
  intakeCreate(body: { name: string; project_id: number; for_session?: string; app_feedback?: boolean }) {
    return this.postJSON<IntakeChannel | Queued | { error: string }>("/api/org/intake", body)
  }
  intakeUpdate(body: { id: string; name?: string; for_session?: string; app_feedback?: boolean }) {
    return this.postJSON<IntakeChannel | { error: string }>("/api/org/intake/update", body)
  }
  intakeRotate(id: string) {
    return this.postJSON<IntakeChannel | Queued | { error: string }>("/api/org/intake/rotate", { id })
  }
  intakeDelete(id: string) {
    return this.postJSON<{ deleted: boolean }>("/api/org/intake/delete", { id })
  }
  // ---- integrations (accounts + the services agents may use on them) ----
  integrations() {
    return this.getJSON<IntegrationsView>("/api/integrations")
  }
  /** Consent for `service` — on `connection` (adds the permission, keeps the
   *  rest) or, without one, on a new account. Poll the pending handle with
   *  driveOAuthStatus(). Human-only. */
  integrationConnect(body: { service: string; connection?: string; op?: string }) {
    return this.postJSON<{ url: string; pending: string; connection: string } | { error?: string }>(
      "/api/integrations/connect", body
    )
  }
  /** Connect an API-token provider (Cloudflare, Hetzner…), or with
   *  `connection` replace that account's token. The server checks the token
   *  with the vendor before saving. Returns the fresh view. Human-only. */
  integrationToken(body: { provider: string; token: string; fields?: Record<string, string>; connection?: string }) {
    return this.postJSON<IntegrationsView | { error?: string }>("/api/integrations/token", body)
  }
  /** Save a provider's OAuth client. Omit client_secret to keep the stored
   *  one; send "" to clear it. Returns the fresh view. Human-only. */
  integrationClientSave(body: { provider: string; client_id: string; client_secret?: string }) {
    return this.postJSON<IntegrationsView | { error?: string }>("/api/integrations/client", body)
  }
  integrationClientDelete(provider: string) {
    return this.postJSON<IntegrationsView | { error?: string }>("/api/integrations/client/delete", { provider })
  }
  /** The owner's on/off switch for a granted service; returns the fresh view. */
  integrationService(body: { connection: string; service: string; on: boolean }) {
    return this.postJSON<IntegrationsView | { error?: string }>("/api/integrations/service", body)
  }
  /** The owner's switch for one thing agents may do with a service. */
  integrationOp(body: { connection: string; service: string; op: string; on: boolean }) {
    return this.postJSON<IntegrationsView | { error?: string }>("/api/integrations/op", body)
  }
  /** Narrow a files account to one existing folder ("/" = the whole account). */
  integrationRoot(body: { connection: string; root: string }) {
    return this.postJSON<IntegrationsView | { error?: string }>("/api/integrations/root", body)
  }
  /** The folders agents may work in on this machine, and what they may do there. */
  integrationLocal(body: { roots: string[]; ops: string[] }) {
    return this.postJSON<IntegrationsView | { error?: string }>("/api/integrations/local", body)
  }

  // ---- browser panel ----
  browserOp(op: string, body: Body) {
    return this.postRes(`/api/browser/${op}`, this.wh(body))
  }
  browserStatus() {
    return this.getJSON("/api/browser/status" + this.qs("?"))
  }
  browserTabs() {
    return this.getJSON("/api/browser/tabs" + this.qs("?"))
  }

  // ---- user accounts (viewer app login) ----
  authState() {
    return this.getJSON("/api/auth/state")
  }
  signup(body: Body) {
    return this.postJSON("/api/auth/signup", body)
  }
  signin(body: Body) {
    return this.postJSON("/api/auth/signin", body)
  }
  signout() {
    return this.postRes("/api/auth/signout")
  }
  /** One-time code a phone redeems by scanning the Pair-a-phone QR. */
  pairStart() {
    return this.postStrict<{ code: string; expiresAt: number; ttl: number; publicUrl?: string; relay?: RelayOffer | null }>(
      "/api/auth/pair/start"
    )
  }
  /** The Harman relay: on/off, whether HARMAN_RELAY_URL pins it, live link. */
  relayStatus() {
    return this.getStrict<RelayStatus>("/api/relay")
  }
  /** The owner's relay switch — persisted, applied without a restart. */
  setRelay(enabled: boolean) {
    return this.postStrict<RelayStatus>("/api/relay", { enabled })
  }
  getPrefs<T = any>() {
    return this.getJSON<T>("/api/prefs")
  }

  // ---- auth (Claude/agent OAuth) ----
  authStatus() {
    return this.getJSON("/api/auth/status")
  }
  authLoginStart() {
    return this.postRes("/api/auth/login/start")
  }
  authLoginPoll() {
    return this.getJSON("/api/auth/login/poll")
  }
  authLoginCode(body: Body) {
    return this.postRes("/api/auth/login/code", body)
  }
  authLoginCancel() {
    return this.postRes("/api/auth/login/cancel")
  }
}

export const api = new ApiClient()
