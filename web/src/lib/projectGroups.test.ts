import { groupSessions } from "./projectGroups.ts"
import type { OrgProject, SessionListItem } from "./types.ts"

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++
  else { fail++; console.log(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}

const S = (path: string, project: string, modified: number): SessionListItem =>
  ({ path, title: path, project, modified, size: 1 })
const P = (id: number, cwd: string, host = "local", created_at = 5): OrgProject =>
  ({ id, name: cwd, description: "", host, cwd, created_by: "", created_at })

const sessions = [S("a/1.jsonl", "/w/alpha", 10), S("b/2.jsonl", "/w/beta", 30), S("a/3.jsonl", "/w/alpha", 20)]

const g = groupSessions(sessions, [], "local")
eq("chats group by folder, newest first", g.map((x) => x.dir), ["/w/beta", "/w/alpha"])
eq("a group's chats are newest first", g[1].sessions.map((s) => s.path), ["a/3.jsonl", "a/1.jsonl"])

const projects = [P(1, "/w/zeta"), P(2, "/w/alpha/"), P(3, "/w/Echo"), P(4, "/w/remote", "box"), P(5, "")]
const all = groupSessions(sessions, projects, "local")
eq("chat-less projects follow, by name, case-insensitive", all.map((x) => x.dir), ["/w/beta", "/w/alpha", "/w/Echo", "/w/zeta"])
eq("a project with chats is not listed twice (trailing slash)", all.filter((x) => x.dir.startsWith("/w/alpha")).length, 1)
eq("a chat-less project has no sessions", all[3].sessions.length, 0)
eq("another host's projects stay on that host", groupSessions([], projects, "box").map((x) => x.dir), ["/w/remote"])
eq("a project whose folder is gone is left out", groupSessions([], [{ ...P(6, "/w/gone"), missing: true }], "local"), [])
eq("no chats and no projects is an empty rail", groupSessions([], [], "local"), [])

console.log(`projectGroups: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
