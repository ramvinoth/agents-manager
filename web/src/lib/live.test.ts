import { matches, parse, type LiveEvent } from "./live.ts"

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++
  else { fail++; console.log(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}

const card = (project_id: number | null): LiveEvent => ({ t: "change", table: "cards", id: 1, op: "INSERT", project_id })

eq("resync matches anything", matches({ t: "resync" }, ["cards"], 3), true)
eq("ping never matches", matches({ t: "ping" }, ["cards"], 3), false)
eq("same project matches", matches(card(3), ["cards"], 3), true)
eq("other project does not", matches(card(4), ["cards"], 3), false)
eq("unscoped event matches every project", matches(card(null), ["cards"], 3), true)
eq("unscoped view wants every project", matches(card(4), ["cards"], null), true)
eq("other table does not", matches(card(3), ["notes"], 3), false)


eq("parse change", parse('{"t":"change","table":"cards","id":1,"op":"","project_id":null}')?.t, "change")
eq("parse junk", parse("nope"), null)
eq("parse non-event", parse('{"x":1}'), null)

console.log(`live: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
