import assert from "node:assert/strict"
import { test } from "node:test"
import { createNotificationRouter, notificationTarget, subscribeNotificationResponses } from "./notificationTap.ts"

test("payload validation and legacy local-host fallback", () => {
  for (const data of [null, [], {}, { session: 2 }, { session: "" }]) assert.equal(notificationTarget(data), null)
  assert.deepEqual(notificationTarget({ session: "abc" }), { session: "abc", host: "local" })
})

test("cold taps buffer until ready, latest wins, and changed server blocks stale resolution", async () => {
  let ready = false
  let scope = "server-a"
  const opened: string[] = []
  let finish!: (value: string) => void
  const targets: string[] = []
  const router = createNotificationRouter<string>({
    ready: () => ready, scope: () => scope,
    resolve: (target) => { targets.push(target.session); return new Promise((resolve) => { finish = resolve }) },
    navigate: (value) => { opened.push(value) },
  })
  router.tap({ session: "old" })
  router.tap({ session: "latest" })
  assert.deepEqual(targets, [])
  ready = true
  const flushed = router.flush()
  assert.deepEqual(targets, ["latest"])
  finish("latest")
  await flushed
  assert.deepEqual(opened, ["latest"])
  router.tap({ session: "stale" })
  scope = "server-b"
  finish("stale")
  await Promise.resolve()
  assert.deepEqual(opened, ["latest"])
})

test("warm response is subscribed first and deduped against persistent cold response", async () => {
  const response = { notification: { request: { identifier: "id", content: { data: { session: "chat" } } } } }
  let listener!: (response: unknown) => void
  let finish!: (response: unknown) => void
  let removed = 0
  const delivered: unknown[] = []
  const seen = new Set<string>()
  const native = {
    addNotificationResponseReceivedListener(fn: (response: unknown) => void) { listener = fn; return { remove: () => { removed++ } } },
    getLastNotificationResponseAsync: () => new Promise((resolve) => { finish = resolve }),
  }
  const stop = subscribeNotificationResponses(native, (data) => delivered.push(data), seen)
  listener(response)
  await Promise.resolve()
  finish(response)
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(delivered.length, 1)
  stop()
  assert.equal(removed, 1)
  const stopAgain = subscribeNotificationResponses(native, (data) => delivered.push(data), seen)
  await Promise.resolve()
  stopAgain()
  finish({ notification: { request: { identifier: "new", content: { data: { session: "chat" } } } } })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(delivered.length, 1)
})
