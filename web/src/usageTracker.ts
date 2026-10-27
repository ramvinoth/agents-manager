// usageTracker.ts — the DOM half of usage reporting (pure rules: lib/usage.ts).
// Started once after sign-in; one capture-phase click listener, one childList
// observer on <body> (Radix mounts each dialog as a body portal), one timer.

import { controlName, enqueue, seenEvents, type UsageEvent } from "./lib/usage"

const CONTROLS = "button, a[href], [role=button], [role=menuitem], [role=tab], [role=option], [data-track]"
const FLUSH_MS = 15_000

let queue: UsageEvent[] = []
const seenBySurface = new Map<string, Set<string>>()
let openSurfaces = new Set<string>()
let started = false

function nameOf(el: Element): string {
  return controlName({
    track: el.getAttribute("data-track"),
    ariaLabel: el.getAttribute("aria-label"),
    title: el.getAttribute("title"),
    text: (el as HTMLElement).innerText,
  })
}

function dialogTitle(d: Element): string {
  const id = d.getAttribute("aria-labelledby")
  const t = id ? document.getElementById(id) : null
  return controlName({ text: t?.textContent || "" }) || "dialog"
}

/** The surface a control lives on: its dialog's title, else the main page. */
function surfaceOf(el: Element): string {
  const d = el.closest("[role=dialog], [role=alertdialog]")
  return d ? dialogTitle(d) : "main"
}

function push(ev: UsageEvent) {
  queue = enqueue(queue, ev)
}

/** Record every visible, named control on the open surfaces once per visit. */
function scanSeen() {
  const now = Date.now() / 1000
  const dialogs = Array.from(document.querySelectorAll("[role=dialog], [role=alertdialog]"))
  const roots: [string, ParentNode][] = dialogs.length
    ? dialogs.map((d) => [dialogTitle(d), d])
    : [["main", document]]
  for (const [surface, root] of roots) {
    const names = Array.from(root.querySelectorAll(CONTROLS))
      .filter((el) => (el as HTMLElement).offsetParent !== null && (dialogs.length || surfaceOf(el) === "main"))
      .map(nameOf)
    if (!seenBySurface.has(surface)) seenBySurface.set(surface, new Set())
    for (const ev of seenEvents(surface, names, seenBySurface.get(surface)!, now)) push(ev)
  }
}

/** A dialog that just opened is a "view" and starts a fresh seen-visit. */
function onBodyChange() {
  const now = Date.now() / 1000
  const current = new Set(Array.from(document.querySelectorAll("[role=dialog], [role=alertdialog]")).map(dialogTitle))
  for (const s of current) {
    if (openSurfaces.has(s)) continue
    push({ kind: "view", surface: s, ts: now })
    seenBySurface.delete(s)
  }
  openSurfaces = current
  // Let the dialog render its content before counting what is on it.
  window.setTimeout(scanSeen, 800)
}

function onClick(e: MouseEvent) {
  const el = (e.target as Element | null)?.closest?.(CONTROLS)
  if (!el) return
  const name = nameOf(el)
  if (name) push({ kind: "tap", surface: surfaceOf(el), element: name, ts: Date.now() / 1000 })
}

async function flush() {
  if (!queue.length) return
  const batch = queue
  queue = []
  try {
    const r = await fetch("/api/usage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client: "web", events: batch }),
    })
    // Only a transport failure is retried; a refusal (signed out, 4xx) is
    // dropped so a bad batch can't loop forever.
    if (r.status >= 500) for (const ev of batch) push(ev)
  } catch {
    for (const ev of batch) push(ev)
  }
}

/** The page is going away (tab hidden/closed): hand the batch to the browser. */
function onHide() {
  if (document.visibilityState !== "hidden" || !queue.length) return
  const blob = new Blob([JSON.stringify({ client: "web", events: queue })], { type: "application/json" })
  if (navigator.sendBeacon("/api/usage", blob)) queue = []
}

export function startUsageTracking() {
  if (started) return
  started = true
  push({ kind: "view", surface: "main", ts: Date.now() / 1000 })
  document.addEventListener("click", onClick, true)
  document.addEventListener("visibilitychange", onHide)
  new MutationObserver(onBodyChange).observe(document.body, { childList: true })
  window.setTimeout(scanSeen, 1500)
  window.setInterval(() => { scanSeen(); void flush() }, FLUSH_MS)
}

/** An in-app note from the owner about the screen they are on. */
export function recordFeedback(surface: string, detail: string) {
  push({ kind: "feedback", surface, detail, ts: Date.now() / 1000 })
  void flush()
}
