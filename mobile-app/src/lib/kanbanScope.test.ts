import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { test } from "node:test"
import ts from "typescript"
import * as board from "./board.ts"

type Node = { type: any; props: Record<string, any>; children: unknown[] }
function find(tree: unknown, predicate: (node: Node) => boolean): Node | undefined {
  if (!tree || typeof tree !== "object") return
  if (Array.isArray(tree)) { for (const child of tree) { const found = find(child, predicate); if (found) return found }; return }
  const node = tree as Node
  if (predicate(node)) return node
  return find(node.children, predicate)
}
const deferred = () => {
  let resolve!: (value: any) => void, reject!: (reason: any) => void
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
type Call = ReturnType<typeof deferred> & { name: string; filter: any }
const settle = () => new Promise<void>(resolve => setImmediate(resolve))
const columns = [{ id: 1, name: "Shared project todo", position: 1 }, { id: 2, name: "Shared project done", position: 2 }]
const card = (session: string, id = session === "A" ? 11 : 22) => ({ id, title: `${session}-only-card`, session_id: session, project_id: 7, column_id: 1, position: 1, assignee: 3 })

// Actual screen, persistent state/ref/callback slots, dependency-aware effects and
// cleanup. render() deliberately does NOT commit effects: route changes must be
// safe during that pre-effect render too. API completions are entirely deferred.
function harness(params: any = { session: "A", project: 7 }) {
  const slots: any[] = []
  let routeKey = "reused-kanban"
  let cursor = 0, pending: { i: number; fn: Function; deps: any[] }[] = [], writes = 0
  const same = (a: any[] | undefined, b: any[]) => !!a && a.length === b.length && a.every((x, i) => Object.is(x, b[i]))
  const calls: Call[] = [], navigations: any[][] = [], alerts: any[][] = [], timers = new Set<Function>()
  let token: any = "present"
  const react = {
    createElement: (type: unknown, props: any, ...children: unknown[]) => ({ type, props: props || {}, children }),
    useState(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial; return [slots[i], (v: any) => { writes++; slots[i] = typeof v === "function" ? v(slots[i]) : v }] },
    useRef(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i] },
    useCallback(fn: Function, deps: any[]) { const i = cursor++; if (!same(slots[i]?.deps, deps)) slots[i] = { fn, deps }; return slots[i].fn },
    useEffect(fn: Function, deps: any[]) { const i = cursor++; if (!same(slots[i]?.deps, deps)) pending.push({ i, fn, deps }) },
  }
  const api = Object.fromEntries(["orgBoard", "orgCards", "orgEmployees", "openDecisions", "orgMoveCard", "orgAssignCard", "orgCreateCard"].map(name => [name, (filter: any) => { const call = { name, filter, ...deferred() }; calls.push(call); return call.promise }]))
  const modules: Record<string, any> = {
    react: { ...react, default: react },
    "react-native": { ...Object.fromEntries(["ActivityIndicator", "Pressable", "ScrollView", "Text", "TextInput", "TouchableOpacity", "View"].map(x => [x, x])), Alert: { alert: (...args: any[]) => alerts.push(args) } },
    "react-native-gesture-handler": {}, "react-native-reanimated": {},
    "../api/client": { api }, "../lib/board": board, "../lib/decisions": { fmtWaiting: (x: number) => `${Math.max(0, x)}s` },
    "../state/config": { setToken: (value: any) => { token = value } },
    "../components/Icon": { default: "Icon" }, "../components/DecisionCockpit": { default: "DecisionCockpit" }, "../lib/useTheme": { useTheme: () => ({}) },
  }
  const source = readFileSync(resolve(dirname(process.argv[1]), "../screens/KanbanScreen.tsx"), "utf8")
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText
  const exports: { default?: Function } = {}
  new Function("require", "exports", "setInterval", "clearInterval", js)((name: string) => { assert.ok(name in modules, name); return modules[name] }, exports, (fn: Function) => { timers.add(fn); return fn }, (fn: Function) => timers.delete(fn))
  const navigation = { navigate: (...args: any[]) => navigations.push(args), replace: (...args: any[]) => navigations.push(args), setOptions() {} }
  const render = () => { cursor = 0; pending = []; return exports.default!({ route: { key: routeKey, params }, navigation }) }
  const commit = () => { const effects = pending; pending = []; for (const { i, fn, deps } of effects) { slots[i]?.cleanup?.(); slots[i] = { deps, effect: fn, cleanup: fn() } } }
  const go = (next: any, key = routeKey) => { params = next; routeKey = key; return render() }
  const start = () => { render(); commit() }
  const loads = () => calls.filter(c => c.name === "orgCards")
  const finish = async (index: number, session: string) => {
    calls.filter(c => c.name === "orgBoard")[index].resolve({ columns })
    loads()[index].resolve({ cards: [card(session)] })
    calls.filter(c => c.name === "orgEmployees")[index].resolve({ employees: [{ id: 3, name: "Employee" }] })
    calls.filter(c => c.name === "openDecisions")[index]?.resolve({ count: 0, decisions: [] })
    await settle()
  }
  return { render, commit, go, start, calls, loads, finish, navigations, alerts, timers, writes: () => writes, token: () => token,
    poll: () => { for (const fn of timers) fn() },
    unmount: () => { for (const slot of slots) slot?.cleanup?.() },
    replayEffects: () => { for (const slot of slots) { if (slot?.effect) { slot.cleanup?.(); slot.cleanup = slot.effect() } } },
    node: (id: string) => find(render(), n => n.props.testID === id)!,
    drag: () => find(render(), n => n.type?.name === "DraggableCard")!,
  }
}
const visible = (tree: unknown, session: string) => JSON.stringify(tree).includes(`${session}-only-card`)

test("new scope hides retained A during the pre-effect B render, B loading, failure, and retry", async () => {
  const v = harness(); v.start(); await v.finish(0, "A")
  assert.ok(visible(v.render(), "A"))
  assert.equal(visible(v.go({ session: "B", project: 7 }), "A"), false, "pre-effect B exposed retained A cards")
  v.commit(); assert.equal(visible(v.render(), "A"), false)
  v.loads()[1].reject(new Error("B failed")); await settle()
  assert.equal(visible(v.render(), "A"), false)
  v.poll(); await v.finish(2, "B")
  assert.ok(visible(v.render(), "B")); assert.equal(visible(v.render(), "A"), false)
})

for (const outcome of ["success", "error", "401"] as const) {
  test(`late A ${outcome} cannot write success/error/finally or sign out B`, async () => {
    const v = harness(); v.start(); v.go({ session: "B", project: 7 }); v.commit(); await v.finish(1, "B")
    const writes = v.writes()
    if (outcome === "success") await v.finish(0, "A")
    else { v.loads()[0].reject(Object.assign(new Error("STALE_A_ERROR"), { status: outcome === "401" ? 401 : 500 })); await settle() }
    assert.equal(v.writes(), writes, "obsolete completion wrote state")
    assert.ok(visible(v.render(), "B")); assert.equal(visible(v.render(), "A"), false)
    assert.doesNotMatch(JSON.stringify(v.render()), /STALE_A_ERROR/)
    assert.equal(v.token(), "present"); assert.deepEqual(v.navigations, [])
  })
}

test("late A finally cannot end B's initial loading", async () => {
  const v = harness(); v.start(); v.go({ session: "B", project: 7 }); v.commit()
  await v.finish(0, "A")
  assert.ok(find(v.render(), n => n.type === "ActivityIndicator"), "A finally ended B loading")
})

for (const outcome of ["success", "error", "401"] as const) {
  test(`same-scope latest generation wins over older poll ${outcome}`, async () => {
    const v = harness(); v.start(); await v.finish(0, "A"); v.poll(); v.poll(); await v.finish(2, "A-new")
    const writes = v.writes()
    if (outcome === "success") await v.finish(1, "A-old")
    else { v.loads()[1].reject(Object.assign(new Error("OLD_POLL"), { status: outcome === "401" ? 401 : 500 })); await settle() }
    assert.equal(v.writes(), writes); assert.ok(visible(v.render(), "A-new")); assert.equal(v.token(), "present")
  })
}

test("unmount invalidates pending loads and captured polling callback", async () => {
  const v = harness(); v.start(); const poll = [...v.timers][0]; v.unmount(); const writes = v.writes()
  await v.finish(0, "A"); poll()
  assert.equal(v.writes(), writes); assert.equal(v.loads().length, 1); assert.equal(v.timers.size, 0)
})

test("stale open/assign/add/blur/drop/layout/poll callbacks stay dead across A → B → A", async () => {
  const v = harness(); v.start(); await v.finish(0, "A")
  const oldDrag = v.drag(), oldAdd = v.node("kanban-add-1"), oldPoll = [...v.timers][0]
  oldDrag.props.onLongPress(); const oldAssign = v.alerts[0][2][0].onPress
  oldAdd.props.onPress(); v.node("kanban-new-card").props.onChangeText("A draft")
  const oldInput = v.node("kanban-new-card")
  const oldLayout = find(v.render(), n => !!n.props.onLayout)!.props.onLayout
  v.go({ session: "B", project: 7 }); v.commit(); await v.finish(1, "B")
  assert.equal(find(v.render(), n => n.props.testID === "kanban-new-card"), undefined, "A draft leaked into B")
  v.go({ session: "A", project: 7 }); v.commit(); await v.finish(2, "A")
  const count = v.calls.length, writes = v.writes(), alerts = v.alerts.length
  oldDrag.props.onTap(); oldDrag.props.onLongPress(); oldDrag.props.onDropColumn(2)
  oldAssign(); oldAdd.props.onPress(); oldInput.props.onChangeText("stale draft"); oldInput.props.onBlur(); oldInput.props.onSubmitEditing(); oldPoll()
  oldLayout({ nativeEvent: { layout: { x: 999, width: 20 } } })
  await settle()
  assert.equal(v.calls.length, count, "old callback issued a request")
  assert.equal(v.writes(), writes); assert.equal(v.alerts.length, alerts); assert.deepEqual(v.navigations, [])
  assert.deepEqual(v.drag().props.colBounds.current, {}, "old layout contaminated current bounds")
  assert.equal(find(v.render(), n => n.props.testID === "kanban-new-card"), undefined)
})

test("captured A action callbacks cannot revive when route returns to A", async () => {
  const v = harness(); v.start(); await v.finish(0, "A")
  const drag = v.drag(), add = v.node("kanban-add-1"), poll = [...v.timers][0]
  drag.props.onLongPress(); const assign = v.alerts[0][2][0].onPress
  v.go({ session: "B", project: 7 }); v.commit(); await v.finish(1, "B")
  v.go({ session: "A", project: 7 }); v.commit(); await v.finish(2, "A")
  const calls = v.calls.length, writes = v.writes(), alerts = v.alerts.length
  drag.props.onTap(); drag.props.onLongPress(); drag.props.onDropColumn(2); assign(); add.props.onPress(); poll()
  assert.deepEqual(v.navigations, [], "captured A navigation revived")
  assert.equal(v.calls.length, calls); assert.equal(v.writes(), writes); assert.equal(v.alerts.length, alerts)
})

test("scope switch invalidates callbacks and late completions before effect cleanup", async () => {
  const v = harness(); v.start(); await v.finish(0, "A")
  const drag = v.drag(), poll = [...v.timers][0]
  v.poll(); v.go({ session: "B", project: 7 }) // deliberately no commit
  const count = v.calls.length, writes = v.writes()
  drag.props.onTap(); drag.props.onDropColumn(2); poll()
  await v.finish(1, "A")
  assert.equal(v.calls.length, count); assert.equal(v.writes(), writes); assert.deepEqual(v.navigations, [])
  assert.equal(visible(v.render(), "A"), false)
})

test("route-key change creates a fresh lifetime even for identical filters", async () => {
  const v = harness(); v.start(); await v.finish(0, "A")
  const drag = v.drag()
  assert.equal(visible(v.go({ session: "A", project: 7 }, "new-route"), "A"), false)
  drag.props.onTap(); assert.deepEqual(v.navigations, [])
  v.commit(); await v.finish(1, "A"); assert.ok(visible(v.render(), "A"))
})

test("effect cleanup/setup replay invalidates first load but permits current setup", async () => {
  const v = harness(); v.start(); v.replayEffects()
  assert.equal(v.timers.size, 1); assert.equal(v.loads().length, 2)
  await v.finish(1, "A-new"); const writes = v.writes(); await v.finish(0, "A-old")
  assert.equal(v.writes(), writes); assert.ok(visible(v.render(), "A-new"))
})

for (const action of ["add", "assign", "drop"] as const) {
  for (const outcome of ["success", "error"] as const) {
    test(`already-issued ${action} ${outcome} cannot reload or publish obsolete A`, async () => {
      const v = harness(); v.start(); await v.finish(0, "A")
      if (action === "add") { v.node("kanban-add-1").props.onPress(); v.node("kanban-new-card").props.onChangeText("New A"); v.node("kanban-new-card").props.onBlur() }
      if (action === "assign") { v.drag().props.onLongPress(); v.alerts[0][2][0].onPress() }
      if (action === "drop") v.drag().props.onDropColumn(2)
      const mutation = v.calls.find(c => /org(Create|Assign|Move)Card/.test(c.name))!
      assert.ok(mutation)
      v.go({ session: "B", project: 7 }); v.commit(); await v.finish(1, "B")
      const count = v.calls.length, writes = v.writes()
      if (outcome === "success") mutation.resolve({}); else mutation.reject(new Error("STALE_MUTATION"))
      await settle()
      assert.equal(v.calls.length, count); assert.equal(v.writes(), writes); assert.ok(visible(v.render(), "B"))
    })
  }
}

for (const params of [undefined, {}, { session: "" }, { session: "   " }, { session: " ", project: 7 }, { project: 0 }, { assignee: 3 }, { session: "A", project: NaN }, { session: "A", assignee: -1 }]) {
  test(`invalid/missing context makes no API requests: ${JSON.stringify(params)}`, () => {
    const v = harness(null); v.go(params); v.commit(); v.poll()
    assert.equal(v.calls.length, 0)
    assert.ok(find(v.render(), n => n.props.testID === "kanban-unavailable"))
  })
}

test("same-project sessions have shared columns, disjoint cards, and preserve every AND filter", async () => {
  const v = harness({ session: "A", project: 7, assignee: 3 }); v.start(); await v.finish(0, "A")
  assert.deepEqual(v.loads()[0].filter, { session: "A", project: 7, assignee: 3 })
  assert.deepEqual(v.calls.find(c => c.name === "orgBoard")!.filter, { session: "A", project: 7 })
  v.go({ session: "B", project: 7, assignee: 3 }); v.commit(); await v.finish(1, "B")
  assert.deepEqual(v.loads()[1].filter, { session: "B", project: 7, assignee: 3 })
  assert.ok(visible(v.render(), "B")); assert.equal(visible(v.render(), "A"), false)
  assert.match(JSON.stringify(v.render()), /Shared project todo/)
  v.go({ project: 7 }); v.commit(); await v.finish(2, "Project")
  assert.equal(v.loads()[2].filter.project, 7); assert.equal(v.loads()[2].filter.session, undefined)
})

test("current scope 401 still clears token and replaces Login", async () => {
  const v = harness(); v.start(); v.loads()[0].reject(Object.assign(new Error("Unauthorized"), { status: 401 })); await settle()
  assert.equal(v.token(), null); assert.deepEqual(v.navigations, [["Login"]])
})

test("same-scope failed refresh retains identified data; add submit plus blur creates once", async () => {
  const v = harness(); v.start(); await v.finish(0, "A"); v.poll(); v.loads()[1].reject(new Error("Refresh failed")); await settle()
  assert.ok(visible(v.render(), "A"))
  v.node("kanban-add-1").props.onPress(); v.node("kanban-new-card").props.onChangeText("New A")
  const input = v.node("kanban-new-card"); input.props.onSubmitEditing(); input.props.onBlur()
  assert.equal(v.calls.filter(c => c.name === "orgCreateCard").length, 1)
})
