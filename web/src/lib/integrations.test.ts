import { reconnectService, serviceAction, waitForConsent, type ConsentStatus } from "./integrations.ts"
import type { ServiceState } from "./types.ts"
const svc = (id: string, available = true) => ({ id, label: id, kind: "x", agent: "", available, unavailable: "", ops: [] })
const prov = { id: "google", label: "Google", public: false, setup: [], client: { client_id: "", has_secret: false, configured: true },
  services: [svc("keep", false), svc("drive"), svc("gmail")], connections: [] }
const conn = (services: Record<string, ServiceState>) => ({ id: "c", account: "", authorized: true, expired: true, services, ops: {}, root: "/" })


let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++
  else { fail++; console.log(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}

eq("on toggles", serviceAction("on"), "toggle")
eq("off toggles", serviceAction("off"), "toggle")
eq("missing permission asks for consent", serviceAction("grant"), "grant")
eq("unavailable has no control", serviceAction("unavailable"), "none")

eq("reconnect prefers a service the owner has on", reconnectService(prov, conn({ drive: "off", gmail: "on" })), "gmail")
eq("reconnect falls back to the first connectable service", reconnectService(prov, conn({ drive: "grant", gmail: "grant" })), "drive")

const seq = (...s: ConsentStatus[]) => { let i = 0; return async () => s[Math.min(i++, s.length - 1)] }
const noSleep = async () => {}

let slept = 0
await waitForConsent(seq({ status: "waiting" }, { status: "waiting" }, { status: "authorized" }), async () => { slept++ })
eq("polls until authorized, sleeping between waits", slept, 2)

try { await waitForConsent(seq({ status: "failed", error: "Gmail was not granted" }), noSleep); eq("failed rejects", "resolved", "rejected") }
catch (e: any) { eq("failed rejects with the server's reason", e.message, "Gmail was not granted") }

try { await waitForConsent(seq({ status: "expired" }), noSleep); eq("expired rejects", "resolved", "rejected") }
catch (e: any) { eq("expired without a reason still says why", e.message, "Consent expired") }

let polls = 0
try { await waitForConsent(async () => { polls++; return { status: "waiting" } }, noSleep, () => polls >= 1) }
catch (e: any) { eq("a closed dialog stops polling", [e.message, polls], ["Cancelled", 1]) }

console.log(`integrations: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
