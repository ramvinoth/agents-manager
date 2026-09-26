import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { test } from "node:test"
import ts from "typescript"
import { formatActor } from "./board.ts"

// Exercise the actual screen's load callback and rendered branches without
// native dependencies. Native navigation/layout are verified separately.
function screen(response: unknown, status?: number) {
  let postStatus: number | undefined
  let pendingPost: Promise<void> | undefined
  const pendingReads: Promise<unknown>[] = []
  const pendingMoves: Promise<unknown>[] = []
  const pendingAttachments: Promise<unknown>[] = []
  const pendingAssignments: Promise<unknown>[] = []
  const assignments: { card_id: number; assignee: number }[] = []
  const attachments: { card_id: number; project_id: number }[] = []
  const effects: Function[] = []
  const moves: { card_id: number; column_id: number; position: number }[] = []
  const posts: { card_id: number; body: string }[] = []
  const deletes: { card_id: number }[] = []
  const alerts: { title: string; message: string; buttons?: { text: string; onPress?: () => Promise<void> }[] }[] = []
  let deleteStatus: number | undefined
  let deleteResponse: unknown = { deleted: true }
  const states: unknown[] = []
  let cursor = 0
  const callbacks: Function[] = []
  const navigation = { goBack: () => { backs++ }, replace: (name: string) => { replaced = name } }
  let backs = 0, replaced = "", token: unknown = "present"
  const react = {
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
    useState(initial: unknown) {
      const i = cursor++
      if (!(i in states)) states[i] = initial
      return [states[i], (value: unknown) => { states[i] = typeof value === "function" ? value(states[i]) : value }]
    },
    useCallback(fn: Function) { callbacks.push(fn); return fn },
    useEffect(fn: Function) { effects.push(fn) },
    useRef(initial: unknown) {
      const i = cursor++
      if (!(i in states)) states[i] = { current: initial }
      return states[i]
    },
  }
  const native = Object.fromEntries(["ActivityIndicator", "KeyboardAvoidingView", "Pressable", "ScrollView", "Text", "TextInput", "View"].map(x => [x, x]))
  const modules: Record<string, unknown> = {
    react: { ...react, default: react },
    "react-native": { ...native, Platform: { OS: "ios" }, Alert: { alert(title: string, message: string, buttons?: any[]) { alerts.push({ title, message, buttons }) } } },
    "@react-navigation/elements": { useHeaderHeight: () => 40 },
    "react-native-safe-area-context": { useSafeAreaInsets: () => ({ bottom: 0 }) },
    "../api/client": { api: { orgCard: async () => {
      if (pendingReads.length) return await pendingReads.shift()!
      if (status) throw Object.assign(new Error("PRIVATE_SERVER_DETAIL"), { status })
      return response
    }, orgAddCardComment: async (body: { card_id: number; body: string }) => {
      posts.push(body)
      if (pendingPost) await pendingPost
      if (postStatus) throw Object.assign(new Error("PRIVATE_SERVER_DETAIL"), { status: postStatus })
      return { id: 1 }
    }, orgMoveCard: async (body: { card_id: number; column_id: number; position: number }) => {
      moves.push(body)
      if (pendingMoves.length) return await pendingMoves.shift()!
      return { id: body.card_id, column_id: body.column_id }
    }, orgAssignCard: async (body: { card_id: number; assignee: number }) => {
      assignments.push(body)
      if (pendingAssignments.length) return await pendingAssignments.shift()!
      return { id: body.card_id, assignee: body.assignee }
    }, orgEmployees: async () => ({ employees: [{ id: 7, name: "Current worker" }, { id: 8, name: "Next worker" }] }),
    orgProjects: async () => ({ projects: [{ id: 1, name: "First project" }, { id: 2, name: "Second project" }] }),
    orgUpdateCard: async (body: { card_id: number; project_id: number }) => {
      attachments.push(body)
      if (pendingAttachments.length) return await pendingAttachments.shift()!
      return { id: body.card_id, project_id: body.project_id }
    }, orgDeleteCard: async (body: { card_id: number }) => {
      deletes.push(body)
      if (deleteStatus) throw Object.assign(new Error("PRIVATE_SERVER_DETAIL"), { status: deleteStatus })
      return deleteResponse
    } }, isQueued: (r: any) => r?.queued === true },
    "../state/config": { setToken: (value: unknown) => { token = value }, username: () => "" },
    "../components/Icon": { default: "Icon" },
    "../lib/board": { formatActor },
    "../lib/useTheme": { useTheme: () => ({}) },
    "./styles": { useStyles: () => ({}) },
  }
  const source = readFileSync(resolve(dirname(process.argv[1]), "../screens/CardDetailScreen.tsx"), "utf8")
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText
  const exports: { default?: Function } = {}
  new Function("require", "exports", js)((name: string) => {
    assert.ok(name in modules, `Unexpected dependency ${name}`)
    return modules[name]
  }, exports)
  const render = () => { cursor = 0; callbacks.length = 0; effects.length = 0; return exports.default!({ route: { params: { id: 44 } }, navigation }) }
  render()
  return {
    load: () => callbacks[0](), render,
    holdRead: () => {
      let resolve!: (value: unknown) => void
      let reject!: (error: Error) => void
      pendingReads.push(new Promise((yes, no) => { resolve = yes; reject = no }))
      return { resolve, reject }
    },
    respond: (value: unknown, nextStatus?: number) => { response = value; status = nextStatus },
    navigation: () => ({ backs, replaced, token }),
    posts, deletes, alerts, moves, attachments, assignments,
    openAssignment: () => {
      const find = (tree: any): any => {
        if (!tree || typeof tree !== "object") return
        if (Array.isArray(tree)) return tree.map(find).find(Boolean)
        if (tree.type === "Pressable" && JSON.stringify(tree.children).includes("tap to reassign")) return tree
        return find(tree.children)
      }
      const control = find(render())
      assert.ok(control, "Reachable reassignment control")
      control.props.onPress()
      return alerts[alerts.length - 1].buttons!
    },
    holdAssignment: () => {
      let resolve!: (value: unknown) => void
      let reject!: (error: Error) => void
      pendingAssignments.push(new Promise((yes, no) => { resolve = yes; reject = no }))
      return { resolve, reject }
    },
    // Explicitly run one rendered effect pass to fetch project/employee choices.
    // This is not a React lifecycle emulator; stop the polling effect immediately.
    populateProjects: async () => {
      render()
      for (const effect of effects) {
        const cleanup = effect()
        if (typeof cleanup === "function") cleanup()
      }
      await Promise.resolve()
      await Promise.resolve()
    },
    holdAttachment: () => {
      let resolve!: (value: unknown) => void
      let reject!: (error: Error) => void
      pendingAttachments.push(new Promise((yes, no) => { resolve = yes; reject = no }))
      return { resolve, reject }
    },
    holdMove: () => {
      let resolve!: (value: unknown) => void
      let reject!: (error: Error) => void
      pendingMoves.push(new Promise((yes, no) => { resolve = yes; reject = no }))
      return { resolve, reject }
    },
    deletion: (value: unknown, nextStatus?: number) => { deleteResponse = value; deleteStatus = nextStatus },
    failPost: (value?: number) => { postStatus = value },
    holdPost: () => {
      let resolve!: () => void
      let reject!: (error: Error) => void
      pendingPost = new Promise<void>((yes, no) => { resolve = yes; reject = no })
      return { resolve, reject }
    },
    node: (id: string) => {
      const find = (tree: any): any => {
        if (!tree || typeof tree !== "object") return
        if (Array.isArray(tree)) return tree.map(find).find(Boolean)
        return tree.props?.testID === id ? tree : find(tree.children)
      }
      const node = find(render())
      assert.ok(node, id)
      return node
    },
  }
}

const record = { card: { id: 44, title: "Visible card", created_at: 0 }, comments: [], columns: [] }

const movable = { ...record, card: { ...record.card, column_id: 101 }, columns: [
  { id: 101, name: "Todo" }, { id: 102, name: "Doing" }, { id: 103, name: "Done" },
] }

const assigned = { ...movable, card: { ...movable.card, assignee: 7 } }

for (const status of [403, 404]) {
  test(`failed assignment cannot restore a card removed by refresh ${status}`, async () => {
    const view = screen(assigned)
    await view.load()
    await view.populateProjects()
    const pending = view.holdAssignment()
    const action = view.openAssignment().find(b => b.text === "Next worker")!
    const assigning = action.onPress!()
    view.respond(null, status)
    await view.load()
    pending.reject(new Error("PRIVATE_SERVER_DETAIL"))
    await assigning
    assert.ok(JSON.stringify(view.render()).includes("card-detail-unavailable"))
  })
}

test("assignment serializes dialog callbacks, reports failure and permits retry", async () => {
  const view = screen(assigned)
  await view.load()
  await view.populateProjects()
  const actions = view.openAssignment()
  const next = actions.find(b => b.text === "Next worker")!.onPress!
  const pending = view.holdAssignment()
  const assigning = next()
  await next()
  await actions.find(b => b.text === "Current worker")!.onPress!()
  const alertCount = view.alerts.length
  view.node("card-detail-assign").props.onPress()
  assert.equal(view.alerts.length, alertCount, "Do not open another picker during assignment")
  assert.deepEqual(view.assignments, [{ card_id: 44, assignee: 8 }])
  assert.equal(view.node("card-detail-assign").props.disabled, true)
  pending.reject(Object.assign(new Error("PRIVATE_SERVER_DETAIL"), { status: 500 }))
  await assigning
  assert.equal(view.node("card-detail-assign").props.disabled, false)
  assert.match(JSON.stringify(view.alerts), /Could not assign card/)
  assert.doesNotMatch(JSON.stringify(view.alerts), /PRIVATE_SERVER_DETAIL/)
  assert.match(JSON.stringify(view.node("card-detail-assign")), /Current worker/)
  view.respond({ ...assigned, card: { ...assigned.card, assignee: 8 } })
  await view.openAssignment().find(b => b.text === "Next worker")!.onPress!()
  assert.equal(view.assignments.length, 2)
  assert.match(JSON.stringify(view.node("card-detail-assign")), /Next worker/)
})

test("successful assignment stays pending until authoritative refresh completes", async () => {
  const view = screen(assigned)
  await view.load()
  await view.populateProjects()
  const refresh = view.holdRead()
  const assigning = view.openAssignment().find(b => b.text === "Next worker")!.onPress!()
  await Promise.resolve()
  assert.equal(view.node("card-detail-assign").props.disabled, true)
  assert.match(JSON.stringify(view.node("card-detail-assign")), /Current worker/)
  refresh.resolve({ ...assigned, card: { ...assigned.card, assignee: 8 } })
  await assigning
  assert.equal(view.node("card-detail-assign").props.disabled, false)
  assert.match(JSON.stringify(view.node("card-detail-assign")), /Next worker/)
})

for (const status of [403, 500]) {
  test(`accepted assignment with refresh ${status} is not reported as a failed write`, async () => {
    const view = screen(assigned)
    await view.load()
    await view.populateProjects()
    view.respond(null, status)
    await view.openAssignment().find(b => b.text === "Next worker")!.onPress!()
    assert.equal(view.alerts.length, 1, "Only the assignment picker, no write error")
    assert.match(JSON.stringify(view.render()), status === 403 ? /card-detail-unavailable/ : /Could not refresh this card/)
    view.respond({ ...assigned, card: { ...assigned.card, assignee: 8 } })
    await view.load()
    assert.match(JSON.stringify(view.node("card-detail-assign")), /Next worker/)
    assert.equal(view.assignments.length, 1)
  })
}

test("assignment cancellation sends nothing and expired login signs out", async () => {
  const view = screen(assigned)
  await view.load()
  await view.populateProjects()
  const cancel = view.openAssignment().find(b => b.text === "Cancel")!
  await cancel.onPress?.()
  assert.deepEqual(view.assignments, [])
  const pending = view.holdAssignment()
  const assigning = view.openAssignment().find(b => b.text === "Next worker")!.onPress!()
  pending.reject(Object.assign(new Error("PRIVATE_SERVER_DETAIL"), { status: 401 }))
  await assigning
  assert.deepEqual(view.navigation(), { backs: 0, replaced: "Login", token: null })
  assert.equal(view.node("card-detail-assign").props.disabled, false)
  assert.doesNotMatch(JSON.stringify(view.alerts), /PRIVATE_SERVER_DETAIL/)
})

test("failed assignment preserves newer card title and column", async () => {
  const view = screen(assigned)
  await view.load()
  await view.populateProjects()
  const pending = view.holdAssignment()
  const assigning = view.openAssignment().find(b => b.text === "Next worker")!.onPress!()
  view.respond({ ...assigned, card: { ...assigned.card, title: "Updated on server", column_id: 103 } })
  await view.load()
  pending.reject(new Error("PRIVATE_SERVER_DETAIL"))
  await assigning
  assert.ok(JSON.stringify(view.render()).includes("Updated on server"))
  assert.equal(view.node("card-detail-col-103").props.accessibilityState.selected, true)
})

for (const status of [403, 404]) {
  test(`failed attachment cannot restore a card removed by refresh ${status}`, async () => {
    const view = screen(record)
    await view.load()
    await view.populateProjects()
    const pending = view.holdAttachment()
    const attaching = view.node("card-detail-project-1").props.onPress()
    view.respond(null, status)
    await view.load()
    pending.reject(new Error("PRIVATE_SERVER_DETAIL"))
    await attaching
    assert.match(JSON.stringify(view.render()), /card-detail-unavailable/)
    assert.doesNotMatch(JSON.stringify(view.render()), /Visible card/)
  })
}

test("attachment blocks repeated callbacks, reports failure safely and permits retry", async () => {
  const view = screen(record)
  await view.load()
  await view.populateProjects()
  const pending = view.holdAttachment()
  const press = view.node("card-detail-project-1").props.onPress
  const attaching = press()
  await press()
  await view.node("card-detail-project-2").props.onPress()
  assert.deepEqual(view.attachments, [{ card_id: 44, project_id: 1 }])
  assert.equal(view.node("card-detail-project-2").props.disabled, true)
  pending.reject(Object.assign(new Error("PRIVATE_SERVER_DETAIL"), { status: 403 }))
  await attaching
  assert.equal(view.node("card-detail-project-2").props.disabled, false)
  assert.match(JSON.stringify(view.alerts), /Could not attach card/)
  assert.doesNotMatch(JSON.stringify(view.alerts), /PRIVATE_SERVER_DETAIL/)
  view.respond({ ...movable, card: { ...movable.card, project_id: 2 } })
  await view.node("card-detail-project-2").props.onPress()
  assert.deepEqual(view.attachments, [{ card_id: 44, project_id: 1 }, { card_id: 44, project_id: 2 }])
  view.node("card-detail-col-102")
})

test("successful attachment stays pending through the authoritative board refresh", async () => {
  const view = screen(record)
  await view.load()
  await view.populateProjects()
  const refresh = view.holdRead()
  const attaching = view.node("card-detail-project-1").props.onPress()
  await Promise.resolve()
  assert.equal(view.node("card-detail-project-2").props.disabled, true)
  await view.node("card-detail-project-2").props.onPress()
  assert.equal(view.attachments.length, 1)
  refresh.resolve({ ...movable, card: { ...movable.card, project_id: 1 } })
  await attaching
  view.node("card-detail-col-102")
  assert.doesNotMatch(JSON.stringify(view.render()), /card-detail-project-/)
  assert.deepEqual(view.alerts, [])
})

for (const status of [403, 500]) {
  test(`accepted attachment with refresh ${status} uses card-read handling, not a write failure`, async () => {
    const view = screen(record)
    await view.load()
    await view.populateProjects()
    view.respond(null, status)
    await view.node("card-detail-project-1").props.onPress()
    assert.equal(view.attachments.length, 1)
    assert.deepEqual(view.alerts, [])
    const tree = JSON.stringify(view.render())
    assert.match(tree, status === 403 ? /card-detail-unavailable/ : /Could not refresh this card/)
    assert.doesNotMatch(tree, /PRIVATE_SERVER_DETAIL/)
    view.respond(movable)
    await view.load()
    view.node("card-detail-col-102")
    assert.equal(view.attachments.length, 1, "Retrying the read must not resubmit the attachment")
  })
}

test("expired login during attachment signs out and releases pending controls", async () => {
  const view = screen(record)
  await view.load()
  await view.populateProjects()
  const pending = view.holdAttachment()
  const attaching = view.node("card-detail-project-1").props.onPress()
  pending.reject(Object.assign(new Error("PRIVATE_SERVER_DETAIL"), { status: 401 }))
  await attaching
  assert.deepEqual(view.navigation(), { backs: 0, replaced: "Login", token: null })
  assert.equal(view.node("card-detail-project-1").props.disabled, false)
  assert.deepEqual(view.alerts, [])
})

test("failed attachment cannot overwrite a newer server snapshot", async () => {
  const view = screen(record)
  await view.load()
  await view.populateProjects()
  const pending = view.holdAttachment()
  const attaching = view.node("card-detail-project-1").props.onPress()
  view.respond({ ...movable, card: { ...movable.card, title: "Updated on server", project_id: 2 } })
  await view.load()
  pending.reject(new Error("PRIVATE_SERVER_DETAIL"))
  await attaching
  assert.match(JSON.stringify(view.render()), /Updated on server/)
  assert.doesNotMatch(JSON.stringify(view.render()), /Visible card/)
  view.node("card-detail-col-102")
})

for (const status of [403, 404]) {
  test(`failed move cannot restore a card removed by refresh ${status}`, async () => {
    const view = screen(movable)
    await view.load()
    const pending = view.holdMove()
    const moving = view.node("card-detail-col-102").props.onPress()
    view.respond(null, status)
    await view.load()
    pending.reject(new Error("PRIVATE_SERVER_DETAIL"))
    await moving
    assert.match(JSON.stringify(view.render()), /card-detail-unavailable/)
    assert.doesNotMatch(JSON.stringify(view.render()), /Visible card/)
  })
}

test("failed move cannot replace a newer refreshed card snapshot", async () => {
  const view = screen(movable)
  await view.load()
  const pending = view.holdMove()
  const moving = view.node("card-detail-col-102").props.onPress()
  view.respond({ ...movable, card: { ...movable.card, title: "Updated on server", column_id: 103 } })
  await view.load()
  pending.reject(new Error("PRIVATE_SERVER_DETAIL"))
  await moving
  assert.match(JSON.stringify(view.render()), /Updated on server/)
  const count = view.moves.length
  await view.node("card-detail-col-103").props.onPress()
  assert.equal(view.moves.length, count, "Refreshed column remains active")
})

test("move serializes submissions, rolls back its own failure and permits retry", async () => {
  const view = screen(movable)
  await view.load()
  const pending = view.holdMove()
  const press = view.node("card-detail-col-102").props.onPress
  const moving = press()
  await press()
  await view.node("card-detail-col-103").props.onPress()
  assert.equal(view.moves.length, 1, "Pending move blocks stale and fresh callbacks")
  assert.equal(view.node("card-detail-col-103").props.disabled, true)
  pending.reject(new Error("PRIVATE_SERVER_DETAIL"))
  await moving
  assert.equal(view.node("card-detail-col-101").props.accessibilityState.selected, true)
  assert.equal(view.node("card-detail-col-103").props.disabled, false)
  assert.match(JSON.stringify(view.alerts), /Could not move card/)
  assert.doesNotMatch(JSON.stringify(view.alerts), /PRIVATE_SERVER_DETAIL/)
  await view.node("card-detail-col-103").props.onPress()
  assert.equal(view.moves.length, 2)
  assert.equal(view.node("card-detail-col-103").props.accessibilityState.selected, true)
})

test("successful move unlocks controls and leaves its destination selected", async () => {
  const view = screen(movable)
  await view.load()
  const pending = view.holdMove()
  const moving = view.node("card-detail-col-102").props.onPress()
  pending.resolve({ ...movable.card, column_id: 102 })
  await moving
  assert.equal(view.node("card-detail-col-102").props.accessibilityState.selected, true)
  assert.equal(view.node("card-detail-col-103").props.disabled, false)
  await view.node("card-detail-col-102").props.onPress()
  assert.equal(view.moves.length, 1, "Selecting current column remains a no-op")
})

test("expired authentication during move signs out and releases pending state", async () => {
  const view = screen(movable)
  await view.load()
  const pending = view.holdMove()
  const moving = view.node("card-detail-col-102").props.onPress()
  pending.reject(Object.assign(new Error("PRIVATE_SERVER_DETAIL"), { status: 401 }))
  await moving
  assert.deepEqual(view.navigation(), { backs: 0, replaced: "Login", token: null })
  assert.equal(view.node("card-detail-col-102").props.disabled, false)
})

test("late older refresh cannot replace newer card, comments or columns", async () => {
  const view = screen(record)
  const old = view.holdRead()
  const first = view.load()
  view.respond({ ...record, card: { ...record.card, title: "Newest title" }, comments: [{ id: 1, body: "Newest comment", created_at: 0 }], columns: [{ id: 102, name: "Newest column" }] })
  await view.load()
  old.resolve({ ...record, card: { ...record.card, title: "Obsolete title" } })
  await first
  const tree = JSON.stringify(view.render())
  assert.match(tree, /Newest title/)
  assert.match(tree, /Newest comment/)
  assert.match(tree, /Newest column/)
  assert.doesNotMatch(tree, /Obsolete title/)
})

for (const denied of [403, 404]) {
  test(`late successful refresh cannot resurrect card after newer ${denied}`, async () => {
    const view = screen(record)
    await view.load()
    const old = view.holdRead()
    const first = view.load()
    view.respond(null, denied)
    await view.load()
    old.resolve(record)
    await first
    assert.match(JSON.stringify(view.render()), /card-detail-unavailable/)
    assert.doesNotMatch(JSON.stringify(view.render()), /Visible card/)
  })
}

for (const staleStatus of [403, 404, 500]) {
  test(`late older ${staleStatus} cannot erase a newer successful refresh`, async () => {
    const view = screen(record)
    const old = view.holdRead()
    const first = view.load()
    await view.load()
    old.reject(Object.assign(new Error("PRIVATE_SERVER_DETAIL"), { status: staleStatus }))
    await first
    const tree = JSON.stringify(view.render())
    assert.match(tree, /Visible card/)
    assert.doesNotMatch(tree, /card-detail-unavailable|Could not refresh/)
  })
}

test("newer expired-login response is not undone by an older successful read", async () => {
  const view = screen(record)
  const old = view.holdRead()
  const first = view.load()
  view.respond(null, 401)
  await view.load()
  old.resolve(record)
  await first
  assert.equal(view.navigation().replaced, "Login")
  assert.equal(view.navigation().token, null)
  assert.doesNotMatch(JSON.stringify(view.render()), /Visible card/)
})

test("slow overlapping polls render completed data without waiting for every newer request", async () => {
  const view = screen(record)
  const older = view.holdRead()
  const first = view.load()
  const newer = view.holdRead()
  const second = view.load()
  older.resolve(record)
  await first
  assert.match(JSON.stringify(view.render()), /Visible card/)
  newer.resolve({ ...record, card: { ...record.card, title: "Later card" } })
  await second
  assert.match(JSON.stringify(view.render()), /Later card/)
})

test("newer missing-card response wins over an old success and a later retry recovers", async () => {
  const view = screen(record)
  const old = view.holdRead()
  const first = view.load()
  view.respond({ card: null })
  await view.load()
  old.resolve(record)
  await first
  assert.match(JSON.stringify(view.render()), /card-detail-unavailable/)
  view.respond(record)
  await view.load()
  assert.match(JSON.stringify(view.render()), /Visible card/)
})

for (const status of [403, 500]) {
  test(`delete failure ${status} keeps card open and reports a safe error`, async () => {
    const view = screen(record)
    await view.load()
    view.deletion(null, status)
    view.node("card-detail-delete").props.onPress()
    assert.equal(view.deletes.length, 0, "Opening confirmation must not delete")
    await view.alerts[0].buttons!.find(b => b.text === "Delete")!.onPress!()
    assert.equal(view.navigation().backs, 0)
    assert.match(JSON.stringify(view.alerts), /Could not delete/)
    assert.doesNotMatch(JSON.stringify(view.alerts), /PRIVATE_SERVER_DETAIL/)
    assert.match(JSON.stringify(view.render()), /Visible card/)
    view.deletion({ deleted: true })
    view.node("card-detail-delete").props.onPress()
    await view.alerts.at(-1)!.buttons!.find(b => b.text === "Delete")!.onPress!()
    assert.equal(view.navigation().backs, 1)
    assert.deepEqual(view.deletes, [{ card_id: 44 }, { card_id: 44 }])
  })
}

test("expired login during deletion signs out rather than pretending deletion succeeded", async () => {
  const view = screen(record)
  await view.load()
  view.deletion(null, 401)
  view.node("card-detail-delete").props.onPress()
  await view.alerts[0].buttons!.find(b => b.text === "Delete")!.onPress!()
  assert.deepEqual(view.navigation(), { backs: 0, replaced: "Login", token: null })
})

test("queued deletion reports approval and leaves the card available", async () => {
  const view = screen(record)
  await view.load()
  view.deletion({ queued: true, approval: 7 })
  view.node("card-detail-delete").props.onPress()
  await view.alerts[0].buttons!.find(b => b.text === "Delete")!.onPress!()
  assert.equal(view.navigation().backs, 0)
  assert.equal(view.alerts.at(-1)!.title, "Queued")
})

test("unconfirmed deletion stays on card, and cancel never calls the API", async () => {
  const view = screen(record)
  await view.load()
  view.node("card-detail-delete").props.onPress()
  const cancel = view.alerts[0].buttons!.find(b => b.text === "Cancel")!
  await cancel.onPress?.()
  assert.equal(view.deletes.length, 0)
  assert.equal(view.navigation().backs, 0)
  view.deletion({ deleted: false })
  view.node("card-detail-delete").props.onPress()
  await view.alerts.at(-1)!.buttons!.find(b => b.text === "Delete")!.onPress!()
  assert.equal(view.navigation().backs, 0)
  assert.equal(view.alerts.at(-1)!.title, "Deletion not confirmed")
})

for (const edit of ["New draft", ""]) {
  test(`failed pending comment preserves intervening edit ${JSON.stringify(edit)}`, async () => {
    const view = screen(record)
    await view.load()
    view.node("card-detail-comment").props.onChangeText("Original draft")
    const request = view.holdPost()
    const send = view.node("card-detail-send").props.onPress()
    view.node("card-detail-comment").props.onChangeText(edit)
    request.reject(new Error("PRIVATE_SERVER_DETAIL"))
    await send
    assert.equal(view.node("card-detail-comment").props.value, edit)
  })
}

test("pending send retains draft and blocks even a repeated stale callback", async () => {
  const view = screen(record)
  await view.load()
  view.node("card-detail-comment").props.onChangeText("Original draft")
  const request = view.holdPost()
  const press = view.node("card-detail-send").props.onPress
  const first = press()
  const second = press()
  const during = view.node("card-detail-comment").props.value
  const disabled = view.node("card-detail-send").props.disabled
  request.resolve()
  await Promise.all([first, second])
  assert.equal(during, "Original draft")
  assert.equal(disabled, true)
  assert.equal(view.posts.length, 1)
  assert.equal(view.node("card-detail-comment").props.value, "")
})

for (const edits of [["Next comment"], [""], ["Changed", "Original draft"]]) {
  test(`successful pending comment preserves edits ${JSON.stringify(edits)}`, async () => {
    const view = screen(record)
    await view.load()
    view.node("card-detail-comment").props.onChangeText("Original draft")
    const request = view.holdPost()
    const send = view.node("card-detail-send").props.onPress()
    for (const edit of edits) view.node("card-detail-comment").props.onChangeText(edit)
    const during = view.node("card-detail-send").props
    await during.onPress()
    request.resolve()
    await send
    assert.equal(during.disabled, true)
    assert.equal(during.accessibilityState.busy, true)
    assert.equal(view.posts.length, 1)
    assert.equal(view.node("card-detail-comment").props.value, edits.at(-1))
    assert.equal(view.node("card-detail-send").props.accessibilityState.busy, false)
  })
}

test("failed send preserves whitespace and unlocks retry", async () => {
  const view = screen(record)
  await view.load()
  view.node("card-detail-comment").props.onChangeText("  My exact draft\n")
  view.failPost(500)
  await view.node("card-detail-send").props.onPress()
  assert.equal(view.node("card-detail-comment").props.value, "  My exact draft\n")
  assert.equal(view.node("card-detail-send").props.disabled, false)
  assert.equal(view.node("card-detail-send").props.accessibilityState.busy, false)
  assert.deepEqual(view.posts, [{ card_id: 44, body: "My exact draft" }])
})

for (const status of [403, 500]) {
  test(`comment write ${status} keeps draft without displaying server details`, async () => {
    const view = screen(record)
    await view.load()
    view.node("card-detail-comment").props.onChangeText("My comment")
    view.failPost(status)
    await view.node("card-detail-send").props.onPress()
    assert.doesNotMatch(JSON.stringify(view.render()), /PRIVATE_SERVER_DETAIL/)
    assert.equal(view.node("card-detail-comment").props.value, "My comment")
    assert.deepEqual(view.posts, [{ card_id: 44, body: "My comment" }])
  })
}

test("expired authentication on comment write signs out without exposing server details", async () => {
  const view = screen(record)
  await view.load()
  view.node("card-detail-comment").props.onChangeText("My comment")
  view.failPost(401)
  await view.node("card-detail-send").props.onPress()
  assert.equal(view.navigation().replaced, "Login")
  assert.equal(view.navigation().token, null)
  assert.doesNotMatch(JSON.stringify(view.render()), /PRIVATE_SERVER_DETAIL/)
})

test("successful comment is not restored as unsent when its subsequent refresh fails", async () => {
  const view = screen(record)
  await view.load()
  view.node("card-detail-comment").props.onChangeText("Already posted")
  view.respond(null, 500)
  await view.node("card-detail-send").props.onPress()
  assert.equal(view.posts.length, 1)
  assert.equal(view.node("card-detail-comment").props.value, "")
  assert.doesNotMatch(JSON.stringify(view.render()), /PRIVATE_SERVER_DETAIL/)
  assert.match(JSON.stringify(view.render()), /Could not refresh/)
})

test("retry posts the retained draft and clears the old error on success", async () => {
  const view = screen(record)
  await view.load()
  view.node("card-detail-comment").props.onChangeText("Retry me")
  view.failPost(500)
  await view.node("card-detail-send").props.onPress()
  view.failPost()
  view.respond({ ...record, comments: [{ id: 1, body: "Retry me", author: "Owner", created_at: 0 }] })
  await view.node("card-detail-send").props.onPress()
  assert.equal(view.posts.length, 2)
  assert.equal(view.node("card-detail-comment").props.value, "")
  assert.doesNotMatch(JSON.stringify(view.render()), /Could not post/)
  assert.match(JSON.stringify(view.render()), /Retry me/)
})

for (const status of [401, 403, 404]) {
  test(`accepted comment refresh ${status} uses the normal card access handling`, async () => {
    const view = screen(record)
    await view.load()
    view.node("card-detail-comment").props.onChangeText("Posted")
    view.respond(null, status)
    await view.node("card-detail-send").props.onPress()
    assert.equal(view.posts.length, 1)
    if (status === 401) assert.equal(view.navigation().replaced, "Login")
    else assert.match(JSON.stringify(view.render()), /card-detail-unavailable/)
    assert.doesNotMatch(JSON.stringify(view.render()), /PRIVATE_SERVER_DETAIL/)
  })
}

for (const status of [403, 404, 500]) {
  test(`card read ${status} renders safe retry instead of a blank screen or silent back`, async () => {
    const view = screen(null, status)
    await view.load()
    const tree = JSON.stringify(view.render())
    assert.notEqual(tree, "null")
    assert.match(tree, /card-detail-unavailable/)
    assert.match(tree, /card-detail-retry/)
    assert.doesNotMatch(tree, /PRIVATE_SERVER_DETAIL/)
    assert.equal(view.navigation().backs, 0)
  })
}

test("access loss clears a previously visible card and retry restores it", async () => {
  const record = { card: { id: 44, title: "Visible card", body: "PRIVATE_CARD_BODY", created_at: 0 }, comments: [], columns: [] }
  const view = screen(record)
  await view.load()
  assert.match(JSON.stringify(view.render()), /PRIVATE_CARD_BODY/)
  view.respond(null, 403)
  await view.load()
  assert.doesNotMatch(JSON.stringify(view.render()), /PRIVATE_CARD_BODY/)
  view.respond(record)
  await view.load()
  assert.match(JSON.stringify(view.render()), /PRIVATE_CARD_BODY/)
})

test("missing card renders unavailable, while expired authentication still signs out", async () => {
  const absent = screen({ card: null })
  await absent.load()
  assert.match(JSON.stringify(absent.render()), /card-detail-unavailable/)
  assert.equal(absent.navigation().backs, 0)
  const expired = screen(null, 401)
  await expired.load()
  assert.equal(expired.navigation().replaced, "Login")
  assert.equal(expired.navigation().token, null)
})
