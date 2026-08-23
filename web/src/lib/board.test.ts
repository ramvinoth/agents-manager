import { filterCards, orderColumn, groupByColumn, nextPosition, type Card, type BoardColumn } from "./board.ts"

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++
  else { fail++; console.log(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}

const C = (o: Partial<Card> & { id: number }): Card => ({
  title: `c${o.id}`, body: "", column_id: null, assignee: null,
  project_id: null, session_id: null, position: 0,
  created_by: "", created_at: 0, updated_at: 0, ...o,
})
const COL = (o: Partial<BoardColumn> & { id: number; name: string; position: number }): BoardColumn => ({
  project_id: 10, ...o,
})

const cards: Card[] = [
  C({ id: 1, session_id: "s1", project_id: 10, assignee: 100, column_id: 1, position: 2 }),
  C({ id: 2, session_id: "s1", project_id: 10, assignee: 200, column_id: 1, position: 1 }),
  C({ id: 3, session_id: "s2", project_id: 20, assignee: 100, column_id: 2, position: 3 }),
  C({ id: 4, session_id: "s2", project_id: 10, assignee: 200, column_id: 2, position: 1.5 }),
]
const ids = (cs: Card[]) => cs.map((c) => c.id)

// filterCards
eq("no filter", ids(filterCards(cards)), [1, 2, 3, 4])
eq("by session", ids(filterCards(cards, { session: "s1" })), [1, 2])
eq("by project", ids(filterCards(cards, { project: 10 })), [1, 2, 4])
eq("by assignee", ids(filterCards(cards, { assignee: 100 })), [1, 3])
eq("combined AND", ids(filterCards(cards, { session: "s2", project: 10 })), [4])
eq("no match", filterCards(cards, { assignee: 999 }), [])

// orderColumn
eq("order by position", ids(orderColumn([C({ id: 1, position: 3 }), C({ id: 2, position: 1 }), C({ id: 3, position: 2 })])), [2, 3, 1])

// groupByColumn
const columns: BoardColumn[] = [
  COL({ id: 2, name: "Doing", position: 1 }),
  COL({ id: 1, name: "Todo", position: 0 }),
]
const grouped = groupByColumn(cards, columns)
eq("columns in position order", grouped.map((g) => g.column.name), ["Todo", "Doing"])
eq("todo cards ordered", ids(grouped[0].cards), [2, 1])
eq("doing cards ordered", ids(grouped[1].cards), [4, 3])

// orphan cards (column_id matches no column) get an Unsorted leading bucket
const withOrphan = groupByColumn([C({ id: 9, column_id: 99, position: 1 })], columns)
eq("orphan bucketed", withOrphan[0].column.name, "Unsorted")
eq("orphan card present", ids(withOrphan[0].cards), [9])
eq("no orphan bucket when none", groupByColumn(cards, columns).length, 2)

// nextPosition (fractional indexing — must match server orglogic.next_position)
eq("empty column", nextPosition([], 0), 1)
eq("top", nextPosition([C({ id: 1, position: 5 }), C({ id: 2, position: 6 })], 0), 4)
eq("bottom", nextPosition([C({ id: 1, position: 5 }), C({ id: 2, position: 6 })], 2), 7)
eq("middle midpoint", nextPosition([C({ id: 1, position: 4 }), C({ id: 2, position: 6 })], 1), 5)
eq("orders input first", nextPosition([C({ id: 1, position: 6 }), C({ id: 2, position: 4 })], 1), 5)

console.log(`${pass} passing${fail ? `, ${fail} FAILING` : ""}`)
if (fail) process.exit(1)
