import { parseCanvasRef } from "./canvasRef.ts"

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++
  else { fail++; console.log(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}

eq("card", parseCanvasRef("agents://card/12"), { kind: "card", id: "12" })
eq("note", parseCanvasRef(" agents://note/3 "), { kind: "note", id: "3" })
eq("card id must be digits", parseCanvasRef("agents://card/abc"), null)
eq("inbox session", parseCanvasRef("agents://inbox/65cf-1"), { kind: "inbox", id: "65cf-1" })
eq("code path decoded", parseCanvasRef("agents://code/viewer%2Fdb.py"), { kind: "code", id: "viewer/db.py" })
eq("code raw path", parseCanvasRef("agents://code/viewer/db.py"), { kind: "code", id: "viewer/db.py" })
eq("sift", parseCanvasRef("agents://sift/doc-1"), { kind: "sift", id: "doc-1" })
eq("bad escape", parseCanvasRef("agents://code/%E0%A4%A"), null)
eq("unknown kind", parseCanvasRef("agents://app/x"), null)
eq("web link", parseCanvasRef("https://example.com"), null)
eq("empty", parseCanvasRef(undefined), null)
eq("no id", parseCanvasRef("agents://card/"), null)

console.log(`canvasRef: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
