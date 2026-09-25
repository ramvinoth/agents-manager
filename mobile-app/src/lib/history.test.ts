import assert from "node:assert/strict"
import { test } from "node:test"
import { createHistoryPager, type HistoryPage } from "./history.ts"

const page = (start: number): HistoryPage => ({ lines: [], start, size: 1000 })
test("history shares pending reads and releases paging only on completion", async () => {
  const calls: number[] = []
  let finish!: (value: HistoryPage) => void
  const pager = createHistoryPager((tail) => {
    calls.push(tail)
    return new Promise((resolve) => { finish = resolve })
  })
  assert.equal(await pager.more(), undefined)
  const initial = pager.load()
  assert.equal(pager.load(), initial)
  await Promise.resolve()
  assert.deepEqual(calls, [400])
  finish(page(100))
  await initial
  const older = pager.more()
  await Promise.resolve()
  assert.equal(await pager.more(), undefined)
  assert.deepEqual(calls, [400, 800])
  finish(page(0))
  await older
  assert.equal(await pager.more(), undefined)
})

test("completion waits for an older flight then reads the final transcript", async () => {
  let finish!: (value: HistoryPage) => void
  let calls = 0
  const pager = createHistoryPager(() => {
    calls++
    return calls === 1 ? new Promise((resolve) => { finish = resolve }) : Promise.resolve({ ...page(0), lines: ["final"] })
  })
  const first = pager.load()
  await Promise.resolve()
  const final = pager.load(true)
  finish(page(100))
  await first
  assert.deepEqual((await final).lines, ["final"])
  assert.equal(calls, 2)
})

test("history retries the same window after failure and polls retain expanded history", async () => {
  const calls: number[] = []
  let fail = true
  const pager = createHistoryPager(async (tail) => {
    calls.push(tail)
    if (tail === 800 && fail) { fail = false; throw new Error("offline") }
    return page(100)
  })
  await pager.load()
  await assert.rejects(pager.more(), /offline/)
  await pager.more()
  await pager.load()
  assert.deepEqual(calls, [400, 800, 800, 800])
})
