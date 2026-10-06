import assert from "node:assert"
import { reconnectService, serviceAction, waitForConsent, type ConsentStatus } from "./integrations.ts"
import type { ServiceState } from "../api/client.ts"
const svc = (id: string, available = true) => ({ id, label: id, kind: "x", agent: "", available, unavailable: "", ops: [] })
const prov = { id: "google", label: "Google", public: false, setup: [], client: { client_id: "", has_secret: false, configured: true },
  services: [svc("keep", false), svc("drive"), svc("gmail")], connections: [] }
const conn = (services: Record<string, ServiceState>) => ({ id: "c", account: "", authorized: true, expired: true, services, ops: {}, root: "/" })


let passed = 0
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    passed++
  } catch (e) {
    console.error(`✖ ${name}\n  ${(e as Error).message}`)
    process.exitCode = 1
  }
}

const seq = (...s: ConsentStatus[]) => { let i = 0; return async () => s[Math.min(i++, s.length - 1)] }
const noSleep = async () => {}

async function main() {
  await test("each state maps to its control", () => {
    assert.deepStrictEqual(
      (["on", "off", "grant", "unavailable"] as const).map(serviceAction),
      ["toggle", "toggle", "grant", "none"],
    )
  })
  await test("polls until authorized, sleeping between waits", async () => {
    let slept = 0
    await waitForConsent(seq({ status: "waiting" }, { status: "waiting" }, { status: "authorized" }), async () => { slept++ })
    assert.strictEqual(slept, 2)
  })
  await test("a failed consent rejects with the server's reason", async () => {
    await assert.rejects(waitForConsent(seq({ status: "failed", error: "Gmail was not granted" }), noSleep), /Gmail was not granted/)
  })
  await test("an expired consent without a reason still says why", async () => {
    await assert.rejects(waitForConsent(seq({ status: "expired" }), noSleep), /Consent expired/)
  })
  await test("reconnect prefers a service the owner has on, else the first connectable", async () => {
    assert.strictEqual(reconnectService(prov, conn({ drive: "off", gmail: "on" })), "gmail")
    assert.strictEqual(reconnectService(prov, conn({ drive: "grant", gmail: "grant" })), "drive")
  })
  await test("leaving the screen stops polling", async () => {
    let polls = 0
    await assert.rejects(waitForConsent(async () => { polls++; return { status: "waiting" } }, noSleep, () => polls >= 1), /Cancelled/)
    assert.strictEqual(polls, 1)
  })
  console.log(`integrations: ${passed} passed`)
}
main()
