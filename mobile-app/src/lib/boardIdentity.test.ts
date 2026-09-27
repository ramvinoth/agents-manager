import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { test } from "node:test"
import { CommonActions, StackRouter } from "@react-navigation/routers"
import ts from "typescript"
import * as boardSwipe from "./boardSwipe.ts"

// Run the actual Thread component, not a copy of its identity expression. The
// hook runner preserves state/memo deps and commits layout before passive effects,
// including dependency cleanup and unmount. Native rendering remains a separate gate.
type Node = { type: unknown; props: Record<string, any>; children: unknown[] }
type Route = { key: string; name: string; params: Record<string, any> }
function find(tree: any, id: string): Node | undefined {
  if (!tree || typeof tree !== "object") return
  if (Array.isArray(tree)) { for (const n of tree) { const hit = find(n, id); if (hit) return hit }; return }
  if (tree.props?.testID === id) return tree
  return find(tree.children, id)
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve))
const params = (id?: string) => ({ host: "local", path: id ? `/sessions/${id}.jsonl` : undefined, label: id || "New chat", agent: "claude" })
function routes() {
  const router = StackRouter({ initialRouteName: "Thread" })
  const options = { routeNames: ["Thread", "Kanban", "Org", "SessionProfile"], routeParamList: { Thread: params("A") }, routeGetIdList: {} }
  let state = router.getInitialState(options)
  return {
    current: () => state.routes[state.index] as Route,
    navigate(p: Record<string, any>) {
      const next = router.getStateForAction(state, CommonActions.navigate({ name: "Thread", params: p }), options)
      assert.ok(next)
      // Navigation builders rehydrate router results: RESET may return a partial
      // state, while NAVIGATE normally returns an already-hydrated state unchanged.
      state = router.getRehydratedState(next, options)
      return state.routes[state.index] as Route
    },
  }
}
function screen(initial: Route) {
  const slots: any[] = []
  let cursor = 0, route = initial, tree: any, options: any, focused = true
  const layout = new Map<number, Function>(), passive = new Map<number, Function>()
  const intervals = new Map<number, Function>(), timers = new Map<number, Function>()
  let timerId = 0
  const reads: Array<{ path: string } & ReturnType<typeof deferred<any>>> = []
  const chats: Array<{ request: any } & ReturnType<typeof deferred<any>>> = []
  const navigations: any[][] = [], alerts: any[][] = []
  const equal = (a: any[] | undefined, b: any[] | undefined) => !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
  const effect = (queue: Map<number, Function>, fn: Function, deps?: any[]) => {
    const i = cursor++, previous = slots[i]
    if (previous && equal(previous.deps, deps)) return
    slots[i] = { deps, cleanup: previous?.cleanup }
    queue.set(i, fn)
  }
  const flush = (queue: Map<number, Function>) => {
    for (const [i, fn] of queue) { slots[i].cleanup?.(); slots[i].cleanup = fn() }
    queue.clear()
  }
  const react = {
    createElement: (type: unknown, props: any, ...children: unknown[]) => ({ type, props: props || {}, children }),
    useState(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial; return [slots[i], (v: any) => { slots[i] = typeof v === "function" ? v(slots[i]) : v }] },
    useRef(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i] },
    useMemo(fn: Function, deps?: any[]) { const i = cursor++; if (!(i in slots) || !equal(slots[i].deps, deps)) slots[i] = { deps, value: fn() }; return slots[i].value },
    useCallback(fn: Function, deps?: any[]) { return react.useMemo(() => fn, deps) },
    useEffect: (fn: Function, deps?: any[]) => effect(passive, fn, deps),
    useLayoutEffect: (fn: Function, deps?: any[]) => effect(layout, fn, deps),
  }
  const native = Object.fromEntries(["ActivityIndicator", "FlatList", "Image", "KeyboardAvoidingView", "Pressable", "ScrollView", "Text", "TextInput", "TouchableOpacity", "View"].map(n => [n, n]))
  const modules: Record<string, any> = {
    react: { ...react, default: react },
    "react-native": { ...native, Platform: { OS: "ios" }, Dimensions: { get: () => ({ width: 400 }) }, Animated: { Value: class {}, View: "Animated.View" }, PanResponder: { create: (handlers: any) => ({ panHandlers: handlers }) }, Alert: { alert: (...args: any[]) => alerts.push(args) } },
    "@react-navigation/native": { useFocusEffect: (fn: Function) => effect(passive, () => focused ? fn() : undefined, [fn, focused]) },
    "@react-navigation/elements": { useHeaderHeight: () => 40 },
    "react-native-safe-area-context": { useSafeAreaInsets: () => ({ bottom: 0 }) },
    "../api/client": { api: {
      sessionReadPage: (_host: string, path: string) => { const call = { path, ...deferred<any>() }; reads.push(call); return call.promise },
      sessionMeta: async () => ({}), chatStatus: async () => ({ running: false }), commands: async () => [],
      chat: (request: any) => { const call = { request, ...deferred<any>() }; chats.push(call); return call.promise },
    } },
    "../lib/thread": { groupThread: () => [], parseTranscript: () => [], fmtDate: () => "", itemUuid: () => undefined },
    "../lib/slash": { matchCommands: () => [], slashTerm: () => "" },
    "../lib/thinking": {}, "../lib/plan": {}, "../lib/quote": {}, "../lib/attach": {}, "../lib/voice": {},
    "../lib/search": { findMatches: () => [] },
    "../lib/notify": { ensurePermission: async () => {} },
    "../state/config": { draftFor: () => "", composerPrefs: () => ({}), setDraft: async () => {} },
    "../lib/useTheme": { useTheme: () => ({}) }, "./styles": { useStyles: () => ({}) },
    "../lib/boardSwipe": boardSwipe,
    ...Object.fromEntries(["MessageActions", "SwipeToReply", "CapabilitiesDrawer", "QuestionCard", "PlanCard", "Markdown", "Collapsible", "Icon"].map(n => [`../components/${n}`, { default: n }])),
  }
  const source = readFileSync(resolve(dirname(process.argv[1]), "../screens/ThreadScreen.tsx"), "utf8")
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText
  const exports: { default?: Function } = {}
  new Function("require", "exports", "setTimeout", "clearTimeout", "setInterval", "clearInterval", js)(
    (name: string) => { assert.ok(name in modules, `Unexpected dependency ${name}`); return modules[name] }, exports,
    (fn: Function) => { timers.set(++timerId, fn); return timerId }, (id: number) => timers.delete(id),
    (fn: Function) => { intervals.set(++timerId, fn); return timerId }, (id: number) => intervals.delete(id),
  )
  const navigation = { isFocused: () => focused, setOptions: (value: any) => { options = value }, navigate: (...args: any[]) => navigations.push(args) }
  const render = (next = route) => { route = next; cursor = 0; tree = exports.default!({ route, navigation }); flush(layout); return tree }
  const commit = () => { flush(passive) }
  const menu = () => { find(options.headerRight(), "thread-more")!.props.onPress(); return alerts.at(-1)![2].find((b: any) => b.text === "Board").onPress as Function }
  const profileAction = () => find(options.headerTitle(), "header-title")!.props.onPress as Function
  const profile = () => profileAction()()
  const gesture = (opts: { measured?: number[] } = {}) => {
    const viewport = find(tree, "thread-viewport")!
    assert.ok(viewport)
    // Each layout/touch measures once; the queue lets a test hand back a
    // detached-view measurement (all zeros) before the real one.
    const measured = opts.measured ?? [400, 400]
    viewport.props.ref.current = { measureInWindow: (fn: Function) => { const width = measured.shift() ?? 400; fn(0, 0, width, width ? 800 : 0) } }
    viewport.props.onLayout()
    viewport.props.onTouchStart({ nativeEvent: { touches: [{}] } })
    // Real PanResponder: x0 is still 0 during should-set; the screen derives the
    // start point from moveX - dx (start 395, moved 90pt left).
    const g = { x0: 0, moveX: 305, dx: -90, dy: 2, numberActiveTouches: 1 }
    assert.equal(viewport.props.onMoveShouldSetPanResponder({}, g), true)
    viewport.props.onPanResponderRelease({}, g)
  }
  const send = () => {
    find(tree, "composer-input")!.props.onChangeText("hello")
    render()
    return find(tree, "composer-send")!.props.onPress()
  }
  const unmount = () => { for (const s of slots) s?.cleanup?.(); layout.clear(); passive.clear() }
  return { render, commit, menu, profile, profileAction, gesture, send, reads, chats, navigations, intervals, unmount,
    focus(value: boolean) { focused = value; render(); commit() },
  }
}
async function existing() {
  const router = routes(), first = router.current(), view = screen(first)
  view.render(); view.commit()
  assert.equal(view.reads[0].path, "/sessions/A.jsonl")
  view.reads[0].resolve({ start: 0, lines: [] }); await settle()
  view.render(); view.commit()
  return { router, first, view }
}

for (const method of ["menu", "gesture", "profile"] as const) {
  test(`reused installed Thread route B cannot open retained A via ${method}`, async () => {
    const { router, first, view } = await existing()
    const second = router.navigate(params("B"))
    assert.equal(second.key, first.key, "installed StackRouter reuses the Thread route without getId")
    view.render(second) // layout committed; B's reload passive effect has NOT run
    assert.equal(view.reads.length, 1, "only A has loaded; state survives the reused route")
    if (method === "menu") view.menu()()
    else view[method]()
    assert.equal(view.navigations[0][1][method === "profile" ? "sessionId" : "session"], "B")
    view.unmount()
  })
}

test("captured Board alert and profile actions expire across A → B → A and unmount", async () => {
  const { router, view } = await existing()
  const oldBoard = view.menu(), oldProfile = view.profileAction()
  view.render(router.navigate(params("B"))); view.commit()
  view.render(router.navigate(params("A"))); view.commit()
  oldBoard(); oldProfile()
  assert.deepEqual(view.navigations, [])
  const currentBoard = view.menu(), currentProfile = view.profileAction()
  view.unmount(); currentBoard(); currentProfile()
  assert.deepEqual(view.navigations, [])
})

test("unsent pathless chat offers project selection, never the previous session", async () => {
  const { router, view } = await existing()
  view.render(router.navigate(params())); view.commit(); view.render()
  view.menu()()
  assert.deepEqual(view.navigations, [["Org"]])
  view.unmount()
})

test("pathless chat uses the session returned by its own send for Board and profile", async () => {
  const router = routes(), view = screen(router.navigate(params()))
  view.render(); view.commit(); view.render()
  const sent = view.send()
  view.chats[0].resolve({ session: "CREATED" }); await sent
  view.render()
  view.profile(); view.menu()()
  assert.equal(view.navigations[0][1].sessionId, "CREATED")
  assert.deepEqual(view.navigations[1], ["Kanban", { session: "CREATED", title: "New chat" }])
  view.unmount()
  assert.equal(view.intervals.size, 0)
})

for (const transition of ["different-route", "same-key-return", "unmount"] as const) {
  test(`late new-chat response cannot seed another route lifetime: ${transition}`, async () => {
    const router = routes(), first = router.navigate(params()), view = screen(first)
    view.render(); view.commit(); view.render()
    const sent = view.send()
    if (transition === "different-route") view.render({ ...first, key: `${first.key}-new` })
    else if (transition === "same-key-return") { view.render(router.navigate(params("B"))); view.commit(); view.render(router.navigate(params())) }
    if (transition === "unmount") view.unmount()
    else view.commit()
    view.chats[0].resolve({ session: "OLD-CREATED" }); await sent
    assert.equal(view.intervals.size, 0, "obsolete send cannot start a poll")
    if (transition !== "unmount") {
      view.render(); view.menu()()
      assert.deepEqual(view.navigations, [["Org"]])
      view.unmount()
    }
  })
}

test("a layout measured while covered (no window, zero width) does not disable the next swipe", async () => {
  const { view } = await existing()
  // The board's inline title input raises the keyboard over this screen; the
  // KeyboardAvoidingView relays out the transcript, whose measureInWindow then
  // reports zeros. The touch that follows must re-measure and still claim.
  view.gesture({ measured: [0, 400] })
  assert.equal(view.navigations[0][1].session, "A")
  view.unmount()
})

test("menu → gesture → menu reopens A → B → A with current identity", async () => {
  const { router, view } = await existing()
  view.menu()()
  view.focus(false); view.focus(true)
  view.render(router.navigate(params("B"))); view.commit(); view.render()
  view.gesture()
  view.focus(false); view.focus(true)
  view.render(router.navigate(params("A"))); view.commit(); view.render()
  view.menu()()
  assert.deepEqual(view.navigations.map(n => n[1].session), ["A", "B", "A"])
  view.unmount()
})

test("old transcript completion cannot replace route B's navigation identity", async () => {
  const router = routes(), view = screen(router.current())
  view.render(); view.commit()
  view.render(router.navigate(params("B"))); view.commit()
  view.reads[1].resolve({ start: 0, lines: [] }); await settle()
  view.reads[0].resolve({ start: 0, lines: [] }); await settle()
  view.render(); view.profile(); view.menu()()
  assert.equal(view.navigations[0][1].sessionId, "B")
  assert.equal(view.navigations[1][1].session, "B")
  view.unmount()
})

test("completed new-chat identity does not survive a return to its pathless route", async () => {
  const router = routes(), view = screen(router.navigate(params()))
  view.render(); view.commit(); view.render()
  const sent = view.send()
  view.chats[0].resolve({ session: "CREATED" }); await sent
  view.render(router.navigate(params("B"))); view.commit()
  view.render(router.navigate(params())); view.commit(); view.render()
  view.menu()()
  assert.deepEqual(view.navigations, [["Org"]])
  view.unmount()
})

test("a blank path basename does not reuse previous identity", async () => {
  const { router, view } = await existing()
  view.render(router.navigate({ ...params(), path: "/sessions/   .jsonl" }))
  view.menu()()
  assert.deepEqual(view.navigations, [["Org"]])
  view.unmount()
})
