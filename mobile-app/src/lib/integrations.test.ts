import assert from "node:assert"
import { providerHint, providerOpen, reconnectService, serviceAction, serviceSummary, setupHint, tryPrompt, unavailableNote, waitForConsent, type ConsentStatus } from "./integrations.ts"
import type { ServiceState } from "../api/client.ts"
const svc = (id: string, available = true) => ({ id, label: id, kind: "x", agent: "", try: "List my files.", available, unavailable: "", ops: [] })
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
  await test("setup hint lists only connectable services", () => {
    assert.strictEqual(setupHint(prov), "Set up once, then connect your drive and gmail.")
  })
  await test("unavailable services collapse into one note; none means empty", () => {
    const keep = { ...svc("Keep", false), unavailable: "no API" }
    assert.strictEqual(unavailableNote({ ...prov, services: [keep, svc("drive")] }), "Keep can't be connected: no API.")
    assert.strictEqual(unavailableNote({ ...prov, services: [svc("drive")] }), "")
    assert.strictEqual(unavailableNote({ ...prov, services: [{ ...keep, unavailable: "no API." }] }), "Keep can't be connected: no API.")
  })
  await test("add rows start open only until the first account; a tap opens one", () => {
    const off = { ...prov, client: { ...prov.client, configured: false } }
    assert.deepStrictEqual([providerOpen(prov, null, false), providerOpen(prov, null, true), providerOpen(prov, "google", true), providerOpen(off, "google", false)], [true, false, true, false])
  })
  await test("a provider's hint says what setup unlocks, what to do, or what it offers", () => {
    assert.strictEqual(providerHint(prov, false), "drive, gmail")
    assert.strictEqual(providerHint(prov, true), "Pick what to start with. You can add the rest later.")
    assert.strictEqual(providerHint({ ...prov, client: { client_id: "x", has_secret: false, configured: false } }, false), "Client secret missing. Set up once, then connect your drive and gmail.")
  })
  await test("try names the account so the agent need not ask", () => {
    assert.strictEqual(tryPrompt(svc("Drive"), { ...conn({}), account: "a@b.com" }), "List my files. Use my Drive account a@b.com.")
    assert.strictEqual(tryPrompt(svc("Drive"), conn({})), "List my files.")
  })
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
  await test("a collapsed row summarizes what agents may do there", () => {
    const files = { ...svc("drive"), kind: "files", ops: [{ id: "read", label: "Read" }, { id: "write", label: "Save files" }] }
    const on = (ops: Record<string, ServiceState>, root = "/") => ({ ...conn({ drive: "on" }), ops: { drive: ops }, root })
    assert.strictEqual(serviceSummary(files, on({ read: "on", write: "on" })), "Read, Save files")
    assert.strictEqual(serviceSummary(files, on({ read: "on", write: "off" }, "/Work")), "Read · only /Work")
    assert.strictEqual(serviceSummary(files, on({ read: "off" })), "Nothing allowed")
    assert.deepStrictEqual(
      (["off", "grant", "unavailable"] as const).map((st) => serviceSummary(files, conn({ drive: st }))),
      ["Off", "Needs access", "Not available"],
    )
    assert.strictEqual(serviceSummary(svc("drive"), conn({ drive: "on" })), "On")
  })
  console.log(`integrations: ${passed} passed`)
}
main()
