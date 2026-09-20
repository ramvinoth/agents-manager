// Loopback data only: the installed app renders its actual screens. No proxy,
// filesystem persistence, chat execution or agent spawning is possible here.
const http = require("node:http")
const { createAuditScenario } = require("./audit-fixture-data")
const SESSION = "native-board-fixture"
const NEW_SESSION = "native-ai-created-fixture"
const PROVIDER = "fixture-alpha"
const LONG_MODEL = "fixture/vendor/full-model-id-139"
const columns = [
  { id: 101, name: "To Do", position: 0 },
  { id: 102, name: "In Progress", position: 1 },
  { id: 103, name: "Done", position: 2 },
]
const cards = ["user", "agent"].map((author, i) => ({
  id: 201 + i, title: `${author} fixture card`, body: "Native card details fixture",
  column_id: 101, project_id: 1, session_id: SESSION, assignee: null,
  position: i, created_by: author, created_at: 1, updated_at: 1,
}))
const record = (role, text, index) => JSON.stringify({
  type: role, uuid: `fixture-${index}`, timestamp: "2026-09-19T12:00:00Z",
  message: { role, content: role === "assistant" ? [{ type: "text", text }] : text },
})
const lines = Array.from({ length: 18 }, (_, i) => record(i % 2 ? "assistant" : "user", `History message ${i}`, i))
lines.push(record("user", "Native reply target", 18))
lines.push(record("assistant", [
  "Native horizontal content",
  "```text\nCODE_START " + "wide-content ".repeat(16) + "CODE_END\n```",
  "| TABLE_START | Second | Third | Fourth | TABLE_END |\n" +
  "| --- | --- | --- | --- | --- |\n" +
  "| " + ["first", "second", "third", "fourth", "last"].map(s => s.repeat(14)).join(" | ") + " |",
].join("\n\n"), 19))

const clone = value => JSON.parse(JSON.stringify(value))
const capabilities = { editable: true, customProviders: true, conversationModes: ["agent", "chat"], efforts: ["", "low", "medium", "high", "xhigh", "max"], manualModelId: true }
const initialSelection = { provider: "", model: null, convMode: "agent", effort: "" }
function aiCapabilities(provider = "", host = "local", agent = "claude") {
  return { ...capabilities, editable: agent === "claude", customProviders: agent === "claude" && host === "local", conversationModes: provider ? ["agent", "chat"] : ["agent"], efforts: provider ? [""] : capabilities.efforts }
}
const providers = [
  { id: PROVIDER, name: "Fixture Alpha", model: "fixture-alpha-default" },
  { id: "fixture-beta", name: "Fixture Beta", model: "fixture-beta-default" },
  { id: "fixture-error", name: "Fixture Discovery Failure", model: "fixture-error-default" },
].map(p => ({ ...p, baseUrl: "http://fixture.invalid/v1", hasKey: false, isDefault: false }))
const models = Array.from({ length: 140 }, (_, i) => `fixture/vendor/full-model-id-${String(i).padStart(3, "0")}`)
function validSelection(s) {
  return s && Object.keys(s).sort().join() === "convMode,effort,model,provider" &&
    ["", ...providers.map(p => p.id)].includes(s.provider) && aiCapabilities(s.provider).conversationModes.includes(s.convMode) && aiCapabilities(s.provider).efforts.includes(s.effort) &&
    (s.model === null || (s.model.kind === "default" && Object.keys(s.model).length === 1) ||
      (s.model.kind === "id" && typeof s.model.id === "string" && s.model.id.trim() && Object.keys(s.model).length === 2))
}

async function startFixture({ ai = false, audit = false, port = Number(process.env.E2E_FIXTURE_PORT || 18769) } = {}) {
  const requests = [], forbidden = []
  const auditScenario = audit ? createAuditScenario() : null
  const state = {
    defaults: { revision: 0, configured: false, selection: clone(initialSelection), capabilities },
    sessions: { [SESSION]: { revision: 0, selection: clone(initialSelection), capabilities } },
    creations: [], failNextSave: false, discoveryFailure: true,
  }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1")
    const route = `${req.method} ${url.pathname}`
    const entry = { route, search: url.search }
    requests.push(entry)
    const send = (value, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)) }
    let body = {}
    try {
      let raw = ""
      for await (const chunk of req) {
        raw += chunk
        if (raw.length > 65536) return send({ error: "Fixture body too large" }, 413)
      }
      if (raw) body = JSON.parse(raw)
      if (req.method !== "GET") entry.body = body
    } catch { return send({ error: "Invalid JSON" }, 400) }
    if (route === "GET /api/auth/state") return send({ signupOpen: false, user: null })
    if (route === "POST /api/auth/signin") return send({ user: { id: 1, username: "fixture" }, token: "local-fixture-only" })
    if (route === "GET /api/auth/me") return send({ user: { id: 1, username: "fixture" } })
    if (route === "POST /api/session/seen" || route === "POST /api/push/register") return send({ ok: true })

    if (ai && ["/api/ai/defaults", "/api/session/ai"].includes(url.pathname)) {
      const defaults = url.pathname === "/api/ai/defaults"
      const target = defaults ? state.defaults : state.sessions[req.method === "GET" ? url.searchParams.get("id") : body.id]
      if (!target) return send({ error: "Unknown fixture session" }, 404)
      if (req.method === "GET") return send({ ...target, capabilities: aiCapabilities(url.searchParams.get("provider") ?? target.selection.provider, url.searchParams.get("host") || "local", url.searchParams.get("agent") || "claude") })
      if (req.method === "POST") {
        const allowed = defaults ? ["revision", "selection", "host", "agent"] : ["id", "host", "agent", "revision", "selection"]
        if (Object.keys(body).some(key => !allowed.includes(key)) || !validSelection(body.selection)) return send({ error: "Invalid AI-only transaction" }, 400)
        if ((body.host && body.host !== "local") || (body.agent && body.agent !== "claude")) return send({ error: "Unsupported fixture target" }, 400)
        if (body.revision !== target.revision) return send({ error: "AI settings changed; reopen and retry" }, 409)
        if (state.failNextSave) { state.failNextSave = false; return send({ error: "Fixture save failed; draft must remain" }, 503) }
        target.selection = clone(body.selection)
        target.capabilities = aiCapabilities(body.selection.provider)
        target.revision++
        if (defaults) target.configured = true
        return send(target)
      }
    }
    if (ai && route === "POST /api/new-session") {
      if (!validSelection(body.ai) || typeof body.message !== "string" || !body.message.trim()) return send({ error: "Atomic first-message AI selection required" }, 400)
      if ((body.host && body.host !== "local") || (body.agent && body.agent !== "claude")) return send({ error: "Unsupported fixture target" }, 400)
      state.creations.push(clone(body))
      state.sessions[NEW_SESSION] = { revision: 1, selection: clone(body.ai), capabilities: aiCapabilities(body.ai.provider) }
      return send({ started: true, session: NEW_SESSION })
    }
    if (req.method !== "GET") { forbidden.push(route); return send({ error: "Fixture rejects writes" }, 403) }
    if (auditScenario?.handle(req, url, send)) return
    if (url.pathname === "/api/org/approvals") return send({ approvals: [] })
    if (url.pathname === "/api/org/skills") return send({ skills: [] })
    if (url.pathname === "/api/sessions") return send([{ id: SESSION, title: "Native board fixture", path: `/fixture/${SESSION}.jsonl`, project: "/fixture", modified: Date.now() / 1000 }])
    if (url.pathname === "/api/session/ai") return send({ error: "AI fixture not enabled" }, 404)
    if (url.pathname.startsWith("/api/session/")) return send({ lines, start: 0, size: lines.length })
    if (url.pathname === "/api/session-meta") return send({ pinned: [], cwd: "/fixture" })
    if (url.pathname === "/api/session-summary") return send({ models: [], messages: 20, toolCalls: 0 })
    if (url.pathname === "/api/git/status") return send({ repo: false })
    if (url.pathname === "/api/chat/status") return send({ running: false, pending_approvals: [] })
    if (url.pathname === "/api/resolve" && ai) return send({ found: true, path: `/fixture/${NEW_SESSION}.jsonl` })
    if (url.pathname === "/api/org/harman") return send({ enabled: false, automation_enabled: false, projects: [] })
    if (url.pathname === "/api/org/loop-control") return send({ mode: "none" })
    if (url.pathname === "/api/org/system-preamble") return send({ preamble: "Isolated native fixture" })
    if (url.pathname === "/api/org/board") return send({ columns })
    if (url.pathname === "/api/org/cards") return send({ cards })
    if (url.pathname === "/api/org/card") return send({ card: cards.find(c => c.id === Number(url.searchParams.get("id"))), columns, comments: [] })
    if (url.pathname === "/api/org/employees") return send({ employees: [] })
    if (url.pathname === "/api/org/projects") return send({ projects: [{ id: 1, name: "Fixture project", cwd: "/fixture", host: "local" }] })
    if (url.pathname === "/api/providers") return send({ providers: ai ? providers : [] })
    if (ai && url.pathname === "/api/providers/models") {
      const id = url.searchParams.get("id")
      if (!id) return send({ models: [], choices: [], status: "unsupported", source: "runner", manualModelId: true })
      if (id === "fixture-error" && state.discoveryFailure) return send({ models: [], choices: [], status: "error", source: "endpoint", manualModelId: true, error: "Fixture discovery unavailable" })
      if (!providers.some(p => p.id === id)) return send({ error: "Unknown fixture provider" }, 404)
      return send({ models, choices: models.map(id => ({ id, label: id })), status: "ok", source: "endpoint", manualModelId: true })
    }
    if (url.pathname === "/api/capabilities") return send({ skills: [], mcp: [] })
    if (url.pathname === "/api/projects" && ai) return send([{ name: "Fixture project", cwd: "/fixture" }])
    if (["/api/hosts", "/api/commands", "/api/projects", "/api/loops"].includes(url.pathname)) return send([])
    return send({ error: `Unhandled fixture route: ${route}` }, 404)
  })
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve) })
  return {
    url: `http://127.0.0.1:${server.address().port}`, requests, forbidden, state, audit: auditScenario?.state,
    close: () => new Promise(resolve => { server.close(resolve); server.closeIdleConnections() }),
  }
}
module.exports = { startFixture, SESSION, NEW_SESSION, PROVIDER, LONG_MODEL }
