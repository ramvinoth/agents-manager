import { checksum, collaborator, fnv1a, MAX_BATCH, missingFiles, peerColor, replaceById, Sync, wins, type El } from "./canvasSync.ts"

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++
  else { fail++; console.log(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}

const el = (id: string, version = 1, versionNonce = 5, extra: Partial<El> = {}): El => ({ id, type: "rectangle", version, versionNonce, ...extra })

// Same numbers as orchestrator/canvas_reconcile (tests/unit/test_canvas_reconcile.py pins the server side).
eq("fnv1a empty = offset basis", fnv1a(""), 0x811c9dc5)
eq("fnv1a 'a'", fnv1a("a"), 0xe40c292c)
eq("fnv1a is utf-8", fnv1a("é") === fnv1a("e"), false)
eq("checksum ignores order", checksum([el("b", 2), el("a")]), checksum([el("a"), el("b", 2)]))
eq("checksum skips tombstones", checksum([el("a"), el("x", 3, 1, { isDeleted: true })]), checksum([el("a")]))
eq("checksum is id:version", checksum([el("a", 2), el("b")]), fnv1a("a:2,b:1"))

eq("nothing stored wins", wins(el("a"), undefined), true)
eq("higher version wins", wins(el("a", 3), el("a", 2)), true)
eq("lower version loses", wins(el("a", 1), el("a", 2)), false)
eq("tie: lower nonce wins", wins(el("a", 2, 1), el("a", 2, 9)), true)
eq("tie: higher nonce loses", wins(el("a", 2, 9), el("a", 2, 1)), false)

{
  const s = new Sync()
  s.reset([el("a", 2)])
  eq("held element is not resent", s.outgoing([el("a", 2)]), [])
  eq("edited element is sent", s.outgoing([el("a", 3), el("b")]).flat().map((e) => e.id), ["a", "b"])
  eq("sent element is not sent twice", s.outgoing([el("a", 3), el("b")]), [])
  eq("unacked is not settled", s.settled([el("a", 3), el("b")]), false)
  s.acked()
  eq("acked and nothing new = settled", s.settled([el("a", 3), el("b")]), true)
  eq("a local edit unsettles", s.settled([el("a", 4), el("b")]), false)
  s.acked(); s.acked()
  eq("extra acks never go negative", s.settled([el("a", 3), el("b")]), true)
}

{
  const s = new Sync()
  s.reset([])
  s.received([el("r", 4)])
  eq("received remote is held", s.outgoing([el("r", 4)]), [])
  s.received([el("r", 2)])
  eq("older relay never lowers known", s.outgoing([el("r", 4)]), [])
}

{
  // Reconnect: batches in flight on a dead socket are resent by the diff, not a queue.
  const s = new Sync()
  s.reset([])
  s.outgoing([el("a")])
  s.reset([])                                     // the snapshot never got it
  eq("reconnect resends what the server lacks", s.outgoing([el("a")]).flat().map((e) => e.id), ["a"])
  s.acked()
  eq("reset clears in-flight from the dead socket", s.settled([el("a")]), true)
}

{
  const big = Array.from({ length: MAX_BATCH * 2 + 1 }, (_, i) => el(`e${i}`))
  const s = new Sync()
  s.reset([])
  eq("a paste is chunked under the server cap", s.outgoing(big).map((b) => b.length), [MAX_BATCH, MAX_BATCH, 1])
  s.acked(); s.acked()
  eq("one ack per batch", s.settled(big), false)
  s.acked()
  eq("all batches acked", s.settled(big), true)
}

{
  const up = new Set<string>()
  const s = new Sync((f) => up.has(f))
  s.reset([])
  const img = el("i", 1, 1, { type: "image", fileId: "f1" })
  eq("image waits for its file", s.outgoing([img]), [])
  up.add("f1")
  eq("image goes once uploaded", s.outgoing([img]).flat().map((e) => e.id), ["i"])
  eq("deleted image never waits", new Sync(() => false).outgoing([el("d", 2, 1, { type: "image", fileId: "x", isDeleted: true })]).length, 1)
}

{
  const s = new Sync()
  s.reset([])
  const local = new Map([["a", el("a", 3)], ["b", el("b", 9)], ["c", el("c", 2)], ["d", el("d", 1, 1, { isDeleted: true })]])
  const adopt = s.rejected([
    ["a", "stale", el("a", 5)],             // server is ahead: take it
    ["b", "stale", el("b", 6)],             // we edited past it: keep ours, resend
    ["c", "read-only", null],               // never existed on the server: drop it
    ["d", "read-only", null],               // already gone locally: nothing to do
    [null, "bad id", null],
  ], local)
  eq("adopted ids", adopt.map((e) => [e.id, e.version, !!e.isDeleted]), [["a", 5, false], ["c", 2, true]])
  const after = [...replaceById([...local.values()], adopt)]
  eq("adopted copies are not resent; the newer local one is", s.outgoing(after).flat().map((e) => e.id), ["b"])
  eq("a final refusal adopts even an older winner",
    new Sync().rejected([["a", "element too large", el("a", 2)]], new Map([["a", el("a", 7)]])).map((e) => e.version), [2])
}

eq("replaceById keeps order and the rest", replaceById([el("a"), el("b"), el("c")], [el("b", 7)]).map((e) => `${e.id}${e.version}`), ["a1", "b7", "c1"])
eq("missingFiles: unique, live images only", missingFiles([
  el("i", 1, 1, { type: "image", fileId: "f" }), el("j", 1, 1, { type: "image", fileId: "f" }),
  el("k", 1, 1, { type: "image", fileId: "have" }), el("z", 1, 1, { type: "image", fileId: "g", isDeleted: true }),
], (f) => f === "have"), ["f"])

eq("peer colour is stable", peerColor("abc"), peerColor("abc"))
eq("collaborator uses a valid colour", collaborator({ t: "presence", peer: "p", color: "#123456" }).color.stroke, "#123456")
eq("collaborator replaces junk colour", collaborator({ t: "presence", peer: "p", color: "red;x" }).color.stroke, peerColor("p"))
eq("collaborator drops a non-numeric pointer", collaborator({ t: "presence", peer: "p", pointer: { x: NaN, y: 1 } }).pointer, undefined)
eq("collaborator caps the name", collaborator({ t: "presence", peer: "p", name: "x".repeat(99) }).username.length, 40)

console.log(`canvasSync: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
