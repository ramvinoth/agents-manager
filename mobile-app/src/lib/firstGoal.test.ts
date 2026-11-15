import { ceoStart, CEO_TITLE, GOAL_EXAMPLES } from "./firstGoal.ts"

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++
  else { fail++; console.log(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}

const s = ceoStart("  Research competitors  ")
eq("title", s.title, CEO_TITLE)
eq("goal trimmed", s.goal, "Research competitors")
eq("first message is the goal", s.message, "Research competitors")
eq("prompt names the role", /CEO/.test(s.systemPrompt), true)
eq("examples are sentences", GOAL_EXAMPLES.every((e) => e.trim().length > 10), true)

console.log(`firstGoal: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
