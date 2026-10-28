import { projectLabels, projectParents, projectTree, CHAT_LIMIT } from "./projectTree.ts"
import type { Group } from "./projectGroups.ts"
import type { SessionListItem } from "./types.ts"

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++
  else { fail++; console.log(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}

const S = (path: string, title: string): SessionListItem => ({ path, title, project: "", modified: 1, size: 1 })
const G = (dir: string, sessions: SessionListItem[]): Group =>
  ({ dir, project: dir, sessions, modified: 1, unread: false, running: 0 })

const alpha = G("/w/alpha", [S("a1", "Fix login"), S("a2", "Ship build")])
const beta = G("/w/beta", [S("b1", "Login page copy")])
const empty = G("/w/empty", [])
const big = G("/w/big", Array.from({ length: CHAT_LIMIT + 3 }, (_, i) => S(`g${i}`, `chat ${i}`)))
const groups = [alpha, beta, empty, big]
const dirs = (t: ReturnType<typeof projectTree>) => t.map((n) => n.group.dir)
const paths = (t: ReturnType<typeof projectTree>, dir: string) => t.find((n) => n.group.dir === dir)?.sessions.map((s) => s.path)

let t = projectTree(groups, "", new Set())
eq("unfiltered lists every project", dirs(t), ["/w/alpha", "/w/beta", "/w/empty", "/w/big"])
eq("a shut project lists no chats", t.every((n) => !n.open && n.sessions.length === 0), true)

t = projectTree(groups, "", new Set(["/w/alpha"]))
eq("an open project lists its chats", paths(t, "/w/alpha"), ["a1", "a2"])
eq("other projects stay shut", t.find((n) => n.group.dir === "/w/beta")?.open, false)

t = projectTree(groups, "", new Set(["/w/big"]))
eq("a long project is capped", t[3].sessions.length, CHAT_LIMIT)
eq("the rest are counted as more", t[3].more, 3)
t = projectTree(groups, "", new Set(["/w/big"]), new Set(["/w/big"]))
eq("show all lifts the cap", [t[3].sessions.length, t[3].more], [CHAT_LIMIT + 3, 0])

t = projectTree(groups, "login", new Set())
eq("chat matches show their projects, open", dirs(t), ["/w/alpha", "/w/beta"])
eq("only the matching chats are listed", paths(t, "/w/alpha"), ["a1"])
eq("a filter is case-insensitive", dirs(projectTree(groups, "LOGIN", new Set())), ["/w/alpha", "/w/beta"])

t = projectTree(groups, "empty", new Set())
eq("a name-only match shows the project shut", [dirs(t), t[0].open], [["/w/empty"], false])
t = projectTree(groups, "alpha", new Set(["/w/alpha"]))
eq("a name-only match keeps its open state and all chats", paths(t, "/w/alpha"), ["a1", "a2"])

eq("no match is an empty tree", projectTree(groups, "zzz", new Set()), [])
eq("a blank filter is no filter", dirs(projectTree(groups, "   ", new Set())).length, 4)
eq("the display name is what the filter matches", dirs(projectTree([G("/x/1", [])], "nice", new Set(), new Set(), () => "Nice name")), ["/x/1"])

// Nesting: a project in another project's folder sits under it.
const R = (dir: string, extra: Partial<Group> = {}): Group => ({ ...G(dir, []), ...extra })
const nest = [R("/w"), R("/w/app", { running: 2 }), R("/w/app/web", { unread: true }), R("/w/lib"), R("/x")]
eq("parents: the nearest containing project", Object.fromEntries(projectParents(nest)),
  { "/w/app": "/w", "/w/app/web": "/w/app", "/w/lib": "/w" })
eq("parents: a home folder never parents", projectParents([R("/Users/me"), R("/Users/me/a"), R("/home/me"), R("/home/me/b")]).size, 0)
eq("parents: a folder-name prefix is not a parent", projectParents([R("/w/app"), R("/w/apple")]).size, 0)
t = projectTree(nest, "", new Set())
eq("shut parents hide their sub-projects", [dirs(t), t[0].children.length], [["/w", "/x"], 0])
eq("a shut parent shows its sub-projects' activity", [t[0].subRunning, t[0].subUnread], [2, true])
t = projectTree(nest, "", new Set(["/w"]))
eq("an open parent lists its sub-projects in order", t[0].children.map((n) => n.group.dir), ["/w/app", "/w/lib"])
eq("deeper levels stay shut until opened", t[0].children[0].children.length, 0)
t = projectTree(nest, "", new Set(["/w", "/w/app"]))
eq("an open sub-project lists its own", t[0].children[0].children.map((n) => n.group.dir), ["/w/app/web"])
eq("a filter lists matches flat", dirs(projectTree(nest, "web", new Set())), ["/w/app/web"])

const labels = projectLabels(["/a/agents/web", "/b/site/web", "/a/agents", "web"])
eq("labels: unique name has no hint", labels.get("/a/agents"), { name: "agents", hint: "" })
eq("labels: colliding names get their parent", labels.get("/a/agents/web"), { name: "web", hint: "agents" })
eq("labels: the other collider too", labels.get("/b/site/web"), { name: "web", hint: "site" })
eq("labels: a bare colliding name has no parent to show", labels.get("web"), { name: "web", hint: "" })

console.log(`projectTree: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
