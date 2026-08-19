// api.ts — the single transport layer between the UI and the Python server.
// Ported from the vanilla api.js: endpoint URLs + host-threading live here.
// `host` is set once (by the store) and injected centrally.

import type { Provider } from "./types"

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
  projects() {
    return this.getJSON("/api/projects" + this.qs("?"))
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
    const params =
      "id" in q ? { id: q.id } : { baseUrl: q.baseUrl, ...(q.key ? { key: q.key } : {}) }
    return this.getJSON<{ models: string[]; error?: string }>(
      "/api/providers/models?" + new URLSearchParams(params).toString()
    )
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

  // ---- loops ----
  loops(sessionId: string) {
    return this.getJSON(`/api/loops?session=${sessionId}`)
  }
  loopsCreate(body: Body) {
    return this.postRes("/api/loops", body)
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

  // ---- filesystem picker ----
  fs(path: string, hidden?: boolean) {
    return this.getJSON(
      `/api/fs?path=${encodeURIComponent(path)}&hidden=${hidden ? 1 : 0}` + this.qs()
    )
  }
  fsMkdir(body: Body) {
    return this.postRes("/api/fs/mkdir", this.wh(body))
  }
  fsDelete(body: Body) {
    return this.postRes("/api/fs/delete", this.wh(body))
  }
  fsDownload(path: string): string {
    return `/api/fs/download?path=${encodeURIComponent(path)}` + this.qs()
  }
  /** URL that streams a single .zip bundling `names` inside directory `path`. */
  fsDownloadZip(path: string, names: string[], archive?: string): string {
    const q = new URLSearchParams()
    q.set("path", path)
    q.set("names", JSON.stringify(names))
    if (archive) q.set("archive", archive)
    if (this.host && this.host !== "local") q.set("host", this.host)
    return "/api/fs/download-zip?" + q.toString()
  }
  fsUpload(path: string, files: File[]): Promise<Response> {
    const form = new FormData()
    files.forEach(f => form.append("files", f))
    return fetch(`/api/fs/upload?path=${encodeURIComponent(path)}${this.qs("&")}`, {
      method: "POST",
      body: form,
    })
  }
  fsRename(body: Body) {
    return this.postRes("/api/fs/rename", this.wh(body))
  }
  fsCompress(body: Body) {
    return this.postRes("/api/fs/compress", this.wh(body))
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
