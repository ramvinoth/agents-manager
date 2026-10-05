import { serviceAction, waitForConsent, type ConsentStatus } from "./integrations.ts"

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++
  else { fail++; console.log(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}

eq("on toggles", serviceAction("on"), "toggle")
eq("off toggles", serviceAction("off"), "toggle")
eq("missing permission asks for consent", serviceAction("grant"), "grant")
eq("unavailable has no control", serviceAction("unavailable"), "none")

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
