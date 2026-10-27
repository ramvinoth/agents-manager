import { crumbs, drillTarget } from "./codeMap.ts"
import type { MapNode } from "./types.ts"

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++
  else { fail++; console.error(`FAIL ${label}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`) }
}
const N = (o: Partial<MapNode> & { id: string; kind: MapNode["kind"] }): MapNode =>
  ({ label: o.id, files: 0, symbols: 0, touched: false, ...o })

eq("folder drills to its level", drillTarget(N({ id: "viewer/routes/", kind: "folder" })), { level: "folder", path: "viewer/routes" })
eq("file drills to its insides", drillTarget(N({ id: "viewer/db.py", kind: "file" })), { level: "file", path: "viewer/db.py" })
eq("class is a leaf", drillTarget(N({ id: "a.py#A", kind: "class" })), null)
eq("method is a leaf", drillTarget(N({ id: "a.py#A.f", kind: "method" })), null)

eq("project crumbs", crumbs({ level: "project", path: "" }, "Harman"), [{ level: "project", path: "", label: "Harman" }])
eq("folder crumbs", crumbs({ level: "folder", path: "viewer/routes" }, "H").map((c) => [c.level, c.path]),
  [["project", ""], ["folder", "viewer"], ["folder", "viewer/routes"]])
eq("file crumbs end on the file", crumbs({ level: "file", path: "viewer/db.py" }, "H").map((c) => [c.level, c.path, c.label]),
  [["project", "", "H"], ["folder", "viewer", "viewer"], ["file", "viewer/db.py", "db.py"]])
eq("root-level file", crumbs({ level: "file", path: "server.py" }, "H").map((c) => c.level), ["project", "file"])

console.log(`codeMap: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
