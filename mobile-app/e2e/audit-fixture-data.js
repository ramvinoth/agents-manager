// Deterministic display-v1 responses, not a second implementation of server
// projection. Sentinel exclusion at the raw→DTO boundary belongs to Python tests.
const SENTINELS = ["AUDIT_PRIVATE_COMMENT_9c01", "AUDIT_SECRET_KEY_8b72", "AUDIT_PRIVATE_PROMPT_3a04"]
const results = {
  returned: { category: "returned", label: "Handler returned", explanation: "The handler returned. This does not establish successful execution or task completion." },
  queued: { category: "queued", label: "Queued when recorded", explanation: "The action was queued when recorded. This does not mean it is still pending." },
  denied: { category: "denied", label: "Denied", explanation: "The action was denied when recorded." },
  error: { category: "error", label: "Error", explanation: "An error was recorded. No execution outcome can be inferred." },
  other: { category: "other", label: "Other recorded result", explanation: "The recorded result is not recognized." },
}
function createAuditScenario() {
  const categories = ["returned", "queued", "denied", "error", "other", "returned", "queued", "returned", "returned"]
  const rows = categories.map((category, i) => ({
    id: 309 - i,
    actor: i === 5 ? "Recorded operator with a deliberately long display identity for native wrapping checks" : "Recorded operator",
    action: i === 4 ? "Recorded action" : "Comment on card",
    target: i === 4 ? { label: "Target unavailable" } : { label: "Card #201", card_id: 201 },
    result: results[category],
    created_at: i === 6 ? null : 1789819200 - (i > 5 ? 86400 : 0),
  }))
  const state = { rows, pageSize: 3, failNext: null, cardStatus: 200, responses: [] }
  function handle(req, url, send) {
    if (req.method !== "GET") return false
    if (url.pathname === "/api/org/audit") {
      if (state.failNext) {
        const failure = state.failNext
        state.failNext = null
        if (failure === "network") req.socket.destroy()
        else send({ error: SENTINELS.join(" ") }, failure)
        return true
      }
      const result = url.searchParams.get("result") || "all"
      const before = url.searchParams.get("before")
      const limit = Number(url.searchParams.get("limit") || 50)
      if (url.searchParams.get("view") !== "display-v1" || !(result === "all" || result in results) ||
          !Number.isInteger(limit) || limit < 1 || limit > 200 || (before !== null && !/^[1-9]\d*$/.test(before))) {
        send({ error: "Invalid display-v1 fixture request" }, 400)
        return true
      }
      const matching = state.rows.filter(row => (result === "all" || row.result.category === result) && (before === null || row.id < Number(before)))
      const audit = matching.slice(0, Math.min(limit, state.pageSize))
      const payload = { view: "display-v1", audit, next_before: matching.length > audit.length ? audit[audit.length - 1].id : null }
      state.responses.push(JSON.parse(JSON.stringify(payload)))
      send(payload)
      return true
    }
    if (url.pathname === "/api/org/card" && state.cardStatus !== 200) {
      if (state.cardStatus === "null") send({ card: null, columns: [], comments: [] })
      else if (state.cardStatus === "network") req.socket.destroy()
      else send({ error: SENTINELS.join(" ") }, state.cardStatus)
      return true
    }
    return false
  }
  return { state, handle }
}
module.exports = { createAuditScenario, SENTINELS }
