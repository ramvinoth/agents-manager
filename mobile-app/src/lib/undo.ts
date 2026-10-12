/**
 * Instant action + Undo (card 153). A reversible action happens on screen at
 * once and a toast offers Undo for UNDO_MS. Two shapes:
 *
 * - Deferred commit: the screen updates optimistically and `commit` (the server
 *   call) only runs when the window closes. Undo just restores the screen —
 *   nothing ever reached the server. This is how a permanent server delete
 *   still gets an Undo.
 * - Flip back: the action already ran (archive, pause) and `undo` runs the
 *   inverse. Omit `commit`.
 *
 * One toast at a time: a new action commits the previous one first, as does
 * the app leaving the foreground (flush) — a pending delete is never lost and
 * never silently dropped.
 *
 * Every DELETE confirms first (Ram, 2026-10-11: "Delete chat has no
 * confirmation. This is dangerous."); the Undo is a second net behind the
 * confirm, never a replacement for it. Flips (archive, pause, unshare) need no
 * confirm — Undo alone is enough there. Actions that can neither be held back
 * nor flipped (approval-gated deletes, forgetting credentials, signing out)
 * confirm and skip the Undo.
 */
export const UNDO_MS = 5000

export type UndoAction = {
  label: string                    // "Chat deleted"
  undo: () => void                 // restore the screen (and flip back, if already applied)
  commit?: () => void | Promise<unknown>
}

type Timers = { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void }
const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) }

export function createUndoQueue(timers: Timers = realTimers) {
  let current: { action: UndoAction; handle: unknown } | null = null
  const listeners = new Set<(a: UndoAction | null) => void>()
  const emit = () => listeners.forEach((l) => l(current?.action ?? null))

  function take() {
    const c = current
    if (!c) return null
    timers.clear(c.handle)
    current = null
    emit()
    return c.action
  }
  // Errors belong to the caller's commit (it reports them on its screen); a
  // throw here must not wedge the queue.
  function runCommit(a: UndoAction) {
    try { void Promise.resolve(a.commit?.()).catch(() => {}) } catch { /* reported by commit */ }
  }

  return {
    push(action: UndoAction) {
      const prev = take()
      if (prev) runCommit(prev)
      const handle = timers.set(() => { if (current?.action === action) { current = null; emit(); runCommit(action) } }, UNDO_MS)
      current = { action, handle }
      emit()
    },
    undo() { take()?.undo() },
    flush() { const a = take(); if (a) runCommit(a) },
    dismiss() { take() }, // close the toast early; a flip-back action has nothing left to commit
    current: () => current?.action ?? null,
    subscribe(l: (a: UndoAction | null) => void) { listeners.add(l); return () => { listeners.delete(l) } },
  }
}

/** The app-wide queue the UndoToast host renders. */
export const undoQueue = createUndoQueue()
export const offerUndo = (a: UndoAction) => undoQueue.push(a)
