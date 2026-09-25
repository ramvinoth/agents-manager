import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { test } from "node:test"
import { parseQuestions } from "./auq.ts"

const read = (path: string) => readFileSync(resolve("src/lib", path), "utf8")
test("question reset identity includes choices and selection mode, without a binary NUL", () => {
  const input = (label: string, multiSelect = false) => ({ questions: [{ question: "Choose", options: [{ label, description: "choice" }], multiSelect }] })
  const key = (value: unknown) => JSON.stringify(parseQuestions(value))
  assert.notEqual(key(input("A")), key(input("B")))
  assert.notEqual(key(input("A")), key(input("A", true)))
  assert.equal(key(input("A")), key(input("A")))
  const source = read("../components/QuestionCard.tsx")
  assert.ok(source.includes("key={JSON.stringify(questions)}"))
  assert.ok(!source.includes("\0"))
})
test("baseline keyboard controls retain stable identity and keyboard insets", () => {
  for (const path of ["../screens/SessionProfileScreen.tsx", "../components/SessionSettings.tsx"]) {
    const source = read(path)
    assert.ok(!source.includes("<PillRow"))
    assert.ok(source.includes("renderPill("))
    assert.ok(source.includes("automaticallyAdjustKeyboardInsets"))
  }
  assert.ok(read("../screens/CapabilitiesScreen.tsx").includes('<ScrollView keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>{children}'))
})
test("ports wire native helpers without importing removed voice or session redesign", () => {
  const app = read("../../App.tsx")
  const thread = read("../screens/ThreadScreen.tsx")
  assert.ok(app.includes("onReady={() => void notificationRouter.flush()}"))
  assert.ok(app.includes('name="SessionInfo"'))
  assert.ok(thread.includes("onEndReached={loadMore}"))
  assert.ok(thread.includes("more ? pager.more() : pager.load(fresh)"))
  assert.ok(thread.includes("splitThinking(finalText)"))
  assert.ok(read("../components/SwipeToReply.tsx").includes("onReplyRef.current()"))
  assert.ok(!/VoiceScreen|CallScreen|ReadAloudButton|ProviderPicker/.test(app + thread))
})
