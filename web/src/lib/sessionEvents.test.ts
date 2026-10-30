import { parseSessionEvent, pollStatus, pollTranscript, reactTo, settlesNewChat, watchFrame, IDLE_EVERY } from "./sessionEvents.ts"

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++
  else { fail++; console.log(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}

eq("garbage is ignored", parseSessionEvent("not json"), null)
eq("no type is ignored", parseSessionEvent("{}"), null)
eq("an unknown type is ignored", parseSessionEvent('{"type":"future","session":"a"}'), null)
eq("a per-session event needs its session", parseSessionEvent('{"type":"turn-end"}'), null)
eq("watching needs ok", parseSessionEvent('{"type":"watching","session":"a"}'), null)
eq("hello parses", parseSessionEvent('{"type":"hello"}'), { type: "hello" })
eq("transcript-changed parses", parseSessionEvent('{"type":"transcript-changed","session":"a","size":9}'),
  { type: "transcript-changed", session: "a", size: 9 })

eq("watch frame", JSON.parse(watchFrame([{ session: "s", host: "box", agent: "claude", path: "projects/p/s.jsonl" }])),
  { type: "watch", sessions: [{ session: "s", host: "box", agent: "claude", path: "projects/p/s.jsonl" }] })
eq("an empty watch frame watches nothing", JSON.parse(watchFrame([])), { type: "watch", sessions: [] })

const ev = (s: string) => parseSessionEvent(s)!
eq("resync catches up", reactTo(ev('{"type":"resync"}'), "a"), "catch-up")
eq("list-changed refetches the list, open chat or not", reactTo(ev('{"type":"list-changed"}'), ""), "list")
eq("the open transcript grew", reactTo(ev('{"type":"transcript-changed","session":"a"}'), "a"), "transcript")
eq("another session's growth is ignored", reactTo(ev('{"type":"transcript-changed","session":"b"}'), "a"), null)
eq("no open chat ignores per-session events", reactTo(ev('{"type":"turn-end","session":""}'), ""), null)
for (const t of ["turn-start", "turn-end", "status-changed"])
  eq(`${t} re-checks the run`, reactTo(ev(`{"type":"${t}","session":"a"}`), "a"), "status")
eq("no pending chat: nothing settles", settlesNewChat(ev('{"type":"list-changed"}'), ""), false)
for (const t of ["turn-start", "turn-end", "status-changed", "transcript-changed"]) {
  eq(`${t} of the new chat settles it`, settlesNewChat(ev(`{"type":"${t}","session":"n"}`), "n"), true)
  eq(`${t} of another chat does not`, settlesNewChat(ev(`{"type":"${t}","session":"o"}`), "n"), false)
}
eq("list-changed may be the new file", settlesNewChat(ev('{"type":"list-changed"}'), "n"), true)
eq("resync may have hidden it", settlesNewChat(ev('{"type":"resync"}'), "n"), true)
eq("a ping does not", settlesNewChat(ev('{"type":"ping"}'), "n"), false)
eq("hello needs no action", reactTo(ev('{"type":"hello"}'), "a"), null)
eq("watching needs no action", reactTo(ev('{"type":"watching","session":"a","ok":true}'), "a"), null)

eq("live and seen: never poll the transcript", [pollTranscript(true, true, true, 0), pollTranscript(true, true, false, 0)], [false, false])
eq("live but not seen: poll as if down", pollTranscript(true, false, true, 3), true)
eq("down and running: every tick", [1, 2, 3].map((t) => pollTranscript(false, false, true, t)), [true, true, true])
eq("down and idle: only every IDLE_EVERY-th tick",
  Array.from({ length: IDLE_EVERY * 2 }, (_, t) => pollTranscript(false, false, false, t)).filter(Boolean).length, 2)
eq("status is polled only while down", [pollStatus(true), pollStatus(false)], [false, true])

console.log(`sessionEvents: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
