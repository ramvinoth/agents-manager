// api.ts — the single transport layer between the UI and the Python server.
// Ported from the vanilla api.js: endpoint URLs + host-threading live here.
// `host` is set once (by the store) and injected centrally.

import type { Provider, Employee, HarmanConfig, LoopControl, LoopMode, OrgProject, BoardColumn, Card, CardComment, CardDep, CardFilter, Queued, SessionDetail, OpenDecision, Drive } from "./types"
import type { AIConfig, AIScope, AISelection, ModelDiscovery } from "./aiSelection"

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
      throw Object.assign(new Error(data?.error || `HTTP ${res.status}`), { status: res.status })
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
  /** Patch the Harman config. Turning automation ON is a Red action (manager
   *  scope) — a caller who can't self-approve gets an approval back, not the
   *  config — hence the `| Queued` union. Other keys apply green. */
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
  orgEmployees() {
    return this.getJSON<{ employees: Employee[] }>("/api/org/employees")
  }
  /** Find-or-create the org project for a (host, cwd) directory → the board it maps to. */
  orgProjectForCwd(body: { host: string; cwd: string; name?: string }) {
    return this.postJSON<OrgProject>("/api/org/project-for-cwd", body)
  }
  orgBoard(projectId: number) {
    return this.getJSON<{ columns: BoardColumn[] }>(`/api/org/board?project=${projectId}`)
  }
  orgCards(filter: CardFilter = {}) {
    const p = new URLSearchParams()
    if (filter.session) p.set("session", filter.session)
    if (filter.project != null) p.set("project", String(filter.project))
    if (filter.assignee != null) p.set("assignee", String(filter.assignee))
    const q = p.toString()
    return this.getJSON<{ cards: Card[] }>(`/api/org/cards${q ? "?" + q : ""}`)
  }
  orgCreateCard(body: { title: string; body?: string; column_id?: number; project_id?: number; assignee?: number; session?: string; position?: number }) {
    return this.postJSON<Card>("/api/org/cards", body)
  }
  orgMoveCard(body: { card_id: number; column_id: number; position: number }) {
    return this.postJSON<Card>("/api/org/cards/move", body)
  }
  orgAssignCard(body: { card_id: number; assignee: number }) {
    return this.postJSON<Card>("/api/org/cards/assign", body)
  }
  orgUpdateCard(body: { card_id: number; title?: string; body?: string; column_id?: number; assignee?: number; position?: number }) {
    return this.postJSON<Card>("/api/org/cards/update", body)
  }
  // `card_delete` is Red (viewer/orglogic): a caller who can't self-approve gets
  // an approval back, not a deletion — hence the union.
  orgDeleteCard(cardId: number) {
    return this.postJSON<{ deleted?: boolean } | Queued>("/api/org/cards/delete", { card_id: cardId })
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
  /** Create (omit id) or update a preset. apiKey omitted = keep existing;
   *  contextLimit 0 = clear, omitted = keep. Returns the saved public preset. */
  providerSave(body: {
    id?: string
    name: string
    baseUrl: string
    model: string
    apiKey?: string
    contextLimit?: number
  }) {
    return this.postJSON<Provider & { error?: string }>("/api/providers", body)
  }
  providerDelete(id: string) {
    return this.postJSON<{ deleted?: boolean }>("/api/providers/delete", { id })
  }
  /** List an endpoint's models — from a saved preset (id) or by probing a
   *  baseUrl+key before saving. The key never leaves the server. */
  providerModels(q: { id: string } | { baseUrl: string; key?: string }) {
    const params: Record<string, string> =
      "id" in q ? { id: q.id } : { baseUrl: q.baseUrl, ...(q.key ? { key: q.key } : {}) }
    return this.getJSON<ModelDiscovery & { error?: string }>(
      "/api/providers/models?" + new URLSearchParams(params).toString()
    )
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
    return this.getJSON(`/api/session-meta?session=${encodeURIComponent(path)}` + this.qs())
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
  /** Begin the loopback consent flow for a drive → the URL to open + the
   *  pending handle to poll with driveOAuthStatus(). */
  driveOAuthStart(drive: string) {
    return this.postJSON<{ url: string; pending: string } | { error?: string }>(
      "/api/drive/oauth/start", { drive }
    )
  }
  /** Poll an in-flight consent flow until authorized/failed/expired. */
  driveOAuthStatus(pending: string) {
    return this.getJSON<{ pending: string; status: "waiting" | "authorized" | "failed" | "expired"; error?: string }>(
      `/api/drive/oauth/status?pending=${encodeURIComponent(pending)}`
    )
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
