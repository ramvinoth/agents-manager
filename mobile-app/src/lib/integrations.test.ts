import assert from "node:assert"
import { serviceAction, waitForConsent, type ConsentStatus } from "./integrations.ts"

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
  await test("leaving the screen stops polling", async () => {
    let polls = 0
    await assert.rejects(waitForConsent(async () => { polls++; return { status: "waiting" } }, noSleep, () => polls >= 1), /Cancelled/)
    assert.strictEqual(polls, 1)
  })
  console.log(`integrations: ${passed} passed`)
}
main()
