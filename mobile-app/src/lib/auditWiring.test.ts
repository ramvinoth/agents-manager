import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { test } from "node:test"
import ts from "typescript"
import * as audit from "./audit.ts"

const source = (path: string) => readFileSync(resolve(dirname(process.argv[1]), path), "utf8")
type Node = { type: unknown; props: Record<string, any>; children: unknown[] }
function find(tree: unknown, predicate: (node: Node) => boolean): Node | undefined {
  if (!tree || typeof tree !== "object") return
  if (Array.isArray(tree)) { for (const child of tree) { const found = find(child, predicate); if (found) return found }; return }
  const node = tree as Node
  if (predicate(node)) return node
  return find(node.children, predicate)
}
function harness(path: string, props: Record<string, unknown> = {}) {
  const slots: any[] = []
  let cursor = 0
  const effects: Function[] = []
  const calls: { filter: audit.AuditFilter; before?: number; resolve: (value: audit.AuditPage) => void; reject: (value: unknown) => void }[] = []
  const navigations: unknown[][] = []
  let clearedToken = false
  const react = {
    createElement: (type: unknown, props: Record<string, any>, ...children: unknown[]) => ({ type, props: props || {}, children }),
    useState(initial: unknown) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (v: any) => { slots[i] = typeof v === "function" ? v(slots[i]) : v }] },
    useReducer(reducer: Function, _: unknown, init: Function) { const i = cursor++; if (!(i in slots)) slots[i] = init(); return [slots[i], (event: unknown) => { slots[i] = reducer(slots[i], event) }] },
    useRef(initial: unknown) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i] },
    useMemo(fn: Function) { return fn() },
    useCallback(fn: Function) { return fn },
    useEffect(fn: Function) { effects.push(fn) },
  }
  const modules: Record<string, unknown> = {
    react: { ...react, default: react },
    "react-native": Object.fromEntries(["ActivityIndicator", "Pressable", "SectionList", "ScrollView", "Text", "View"].map(name => [name, name])),
    "react-native-safe-area-context": { useSafeAreaInsets: () => ({ bottom: 0 }) },
    "../api/client": { api: { orgAudit: (filter: audit.AuditFilter, before?: number) => new Promise<audit.AuditPage>((resolve, reject) => calls.push({ filter, before, resolve, reject })) } },
    "../state/config": { setToken: () => { clearedToken = true }, username: () => "" },
    "../lib/useTheme": { useTheme: () => ({}) },
    "../lib/audit": audit,
    "../lib/board": { formatActor: (actor: string) => ({ name: actor, kind: "unknown" }) },
    // The detail screen borrows the feed's badge and chip palette; both are pure markup.
    "./AuditScreen": { ActorBadge: "ActorBadge", toneColors: () => ({ fg: "", bg: "" }) },
  }
  const js = ts.transpileModule(source(path), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText
  const exports: { default?: Function } = {}
  new Function("require", "exports", js)((name: string) => { assert.ok(name in modules, name); return modules[name] }, exports)
  const navigation = { navigate: (...args: unknown[]) => navigations.push(args), replace: (...args: unknown[]) => navigations.push(args) }
  const render = () => { cursor = 0; effects.length = 0; return exports.default!({ navigation, ...props }) }
  const list = () => find(render(), node => node.type === "SectionList")!
  const start = () => { render(); effects[0]() }
  return { render, start, list, calls, navigations, tokenCleared: () => clearedToken }
}
const entry: audit.AuditEntry = { id: 9, actor: "Recorded actor", action: "Move card", target: { label: "Card #44", card_id: 44 }, result: { category: "returned", label: "Handler returned", explanation: "Does not establish success." }, created_at: null }
const page = (id = 9): audit.AuditPage => ({ view: "display-v1", audit: [{ ...entry, id }], next_before: id })
const settle = () => new Promise<void>(resolve => setImmediate(resolve))

test("reachable navigation replaces the Org raw audit consumer", () => {
  const org = source("../screens/OrgScreen.tsx")
  assert.match(org, /navigation.navigate\("Audit"\)/)
  assert.doesNotMatch(org, /api.orgAudit|setAudit|audit.map/)
  const app = source("../../App.tsx")
  assert.match(app, /name="Audit" component=\{AuditScreen\}/)
  assert.match(app, /name="AuditEntry" component=\{AuditEntryScreen\}/)
  const client = source("../api/client.ts")
  assert.match(client, /parseAuditPage\(await req\("GET", auditPath\(result, before\)\), before\)/)
})

test("screen retains rows on refresh failure and requests an explicit older cursor", async () => {
  const view = harness("../screens/AuditScreen.tsx")
  view.start()
  assert.equal(view.calls[0].filter, "all")
  view.calls[0].resolve(page())
  await settle()
  let list = view.list()
  assert.equal(list.props.sections[0].data[0].id, 9)
  list.props.onRefresh()
  view.calls[1].reject(new Error("PRIVATE_SERVER_DETAIL"))
  await settle()
  list = view.list()
  assert.equal(list.props.sections[0].data[0].id, 9)
  assert.match(JSON.stringify(list.props.ListHeaderComponent), /previously loaded/)
  assert.doesNotMatch(JSON.stringify(list.props.ListHeaderComponent), /PRIVATE_SERVER_DETAIL/)
  find(list.props.ListFooterComponent, node => node.props.testID === "audit-load-older")!.props.onPress()
  assert.equal(view.calls[2].before, 9)
  view.calls[2].resolve(page(8))
  await settle()
  assert.deepEqual(view.list().props.sections.flatMap((s: audit.AuditSection) => s.data.map(e => e.id)), [9, 8])
})

test("filter selection supersedes older responses and row opens safe detail", async () => {
  const view = harness("../screens/AuditScreen.tsx")
  view.start()
  find(view.render(), node => node.props.testID === "audit-filter-denied")!.props.onPress()
  assert.equal(view.calls[1].filter, "denied")
  view.calls[1].resolve(page(8))
  await settle()
  view.calls[0].resolve(page(99))
  await settle()
  const list = view.list()
  assert.equal(list.props.sections[0].data[0].id, 8)
  const row = list.props.renderItem({ item: entry })
  row.props.onPress()
  assert.deepEqual(view.navigations[0], ["AuditEntry", { entry }])
})

test("401 preserves existing sign-in handling without displaying server text", async () => {
  const view = harness("../screens/AuditScreen.tsx")
  view.start()
  view.calls[0].reject({ status: 401, message: "PRIVATE_SERVER_DETAIL" })
  await settle()
  assert.equal(view.tokenCleared(), true)
  assert.deepEqual(view.navigations[0], ["Login"])
})

test("detail links only positive card IDs, delegates reads, and has labelled selectable fields", () => {
  const view = harness("../screens/AuditEntryScreen.tsx", { route: { params: { entry } } })
  const tree = view.render()
  find(tree, node => node.props.testID === "audit-entry-card")!.props.onPress()
  assert.deepEqual(view.navigations[0], ["CardDetail", { id: 44 }])
  assert.ok(find(tree, node => node.props.selectable === true))
  for (const label of ["Actor", "Target", "Recorded result", "Recorded at", "Record ID", "Does not establish success."]) assert.match(JSON.stringify(tree), new RegExp(label))
  for (const card_id of [undefined, -1, 0, 1.5, "44"]) {
    const invalid = harness("../screens/AuditEntryScreen.tsx", { route: { params: { entry: { ...entry, target: { label: "Unknown target", card_id } } } } })
    assert.equal(find(invalid.render(), node => node.props.testID === "audit-entry-card"), undefined)
  }
})
