import { norm, resolveLink, openLinkQuery, suggestTitles, completeLink, filterByTags, neighbours, type NoteGraph } from "./noteLinks.ts"

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++
  else { fail++; console.log(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}

eq("norm", norm("  Big   Idea "), "big idea")
const g: NoteGraph = {
  nodes: [
    { id: 1, title: "Plan", kind: "note", project_id: 3, archived: false, pinned: false, tags: ["work", "q4"], updated_at: 1 },
    { id: 2, title: "Ideas", kind: "idea", project_id: 3, archived: false, pinned: false, tags: ["work"], updated_at: 1 },
  ],
  edges: [{ source: 2, target: 1, heading: "", context: "see [[plan]]" }, { source: 1, target: 1, heading: "x", context: "" }],
  ghosts: [{ title: "Later", project_id: 3, from: [2] }],
  tags: [], index: { "3": { plan: 1, ideas: 2 }, "": { loose: 9 } },
}
eq("resolve case-insensitive", resolveLink(g, 3, " PLAN "), 1)
eq("resolve other project = ghost", resolveLink(g, 4, "plan"), null)
eq("resolve no project", resolveLink(g, null, "Loose"), 9)
eq("resolve no graph", resolveLink(null, 3, "plan"), null)

eq("open query", openLinkQuery("see [[Pl", 8), { start: 4, query: "Pl" })
eq("open query empty", openLinkQuery("[[", 2), { start: 0, query: "" })
eq("closed link", openLinkQuery("[[Plan]] x", 10), null)
eq("past alias", openLinkQuery("[[Plan|p", 8), null)
eq("past heading", openLinkQuery("[[Plan#h", 8), null)
eq("across line", openLinkQuery("[[a\nb", 5), null)
eq("no open", openLinkQuery("plain", 5), null)

eq("suggest rank", suggestTitles(["Roadmap", "Plan B", "Plan", "Big plan", "Explanation"], "plan"), ["Plan", "Plan B", "Big plan", "Explanation"])
eq("suggest exclude + dedupe", suggestTitles(["Plan", "plan ", "Ideas"], "", 8, "ideas"), ["Plan"])
eq("suggest blank titles skipped", suggestTitles(["", "  ", "A"], ""), ["A"])

eq("complete", completeLink("see [[Pl rest", 4, 8, "Plan"), { text: "see [[Plan]] rest", caret: 12 })
eq("complete swallows ]]", completeLink("[[Pl]]", 0, 4, "Plan"), { text: "[[Plan]]", caret: 8 })

eq("tags filter all", filterByTags([{ id: 1 }, { id: 2 }, { id: 3 }], g, ["work", "q4"]).map((n) => n.id), [1])
eq("tags none = all", filterByTags([{ id: 1 }, { id: 3 }], g, []).length, 2)

const nb = neighbours(g, 1)
eq("backlinks skip self", nb.backlinks.map((e) => [e.source, e.title]), [[2, "Ideas"]])
eq("links skip self", nb.links.length, 0)
eq("ghosts of 2", neighbours(g, 2).ghosts, ["Later"])


console.log(`noteLinks: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
