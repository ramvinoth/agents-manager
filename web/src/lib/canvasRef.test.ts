import { parseCanvasRef } from "./canvasRef.ts"

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++
  else { fail++; console.log(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}

eq("card", parseCanvasRef("harman://card/12"), { kind: "card", id: "12" })
eq("note", parseCanvasRef(" harman://note/3 "), { kind: "note", id: "3" })
eq("card id must be digits", parseCanvasRef("harman://card/abc"), null)
eq("inbox session", parseCanvasRef("harman://inbox/65cf-1"), { kind: "inbox", id: "65cf-1" })
eq("sift id decoded", parseCanvasRef("harman://sift/doc%2F1"), { kind: "sift", id: "doc/1" })
eq("retired code kind", parseCanvasRef("harman://code/orchestrator/db.py"), null)
eq("sift", parseCanvasRef("harman://sift/doc-1"), { kind: "sift", id: "doc-1" })
eq("bad escape", parseCanvasRef("harman://sift/%E0%A4%A"), null)
eq("unknown kind", parseCanvasRef("harman://app/x"), null)
eq("web link", parseCanvasRef("https://example.com"), null)
eq("empty", parseCanvasRef(undefined), null)
eq("no id", parseCanvasRef("harman://card/"), null)

console.log(`canvasRef: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
