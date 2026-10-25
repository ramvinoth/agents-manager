// One way to show a short list of actions: an in-app bottom sheet, titled with
// what it acts on, rendered by the single ActionSheetHost mounted in App.tsx.
// Not ActionSheetIOS: on some screens (Edit agent, card 173) the native sheet
// silently never presented — the same class of failure as a native Alert
// raised under an RN Modal (see ProviderPicker) — and a menu that sometimes
// does nothing is worse than any look. One JS sheet on both platforms also
// keeps every row reachable by testID in e2e.

export type SheetAction = { text: string; onPress: () => void; destructive?: boolean }
export type SheetRequest = { title: string; actions: SheetAction[] }

export function createActionSheetQueue() {
  let current: SheetRequest | null = null
  const listeners = new Set<(r: SheetRequest | null) => void>()
  const emit = () => listeners.forEach((l) => l(current))
  return {
    current: () => current,
    subscribe(l: (r: SheetRequest | null) => void) { listeners.add(l); return () => { listeners.delete(l) } },
    /** A new sheet replaces one still open: the latest tap is what the owner meant. */
    show(title: string, actions: SheetAction[]) { current = { title, actions }; emit() },
    /** Close the sheet; returns the chosen action (null for Cancel) for the host to run once the sheet is gone. */
    close(index: number | null): SheetAction | null {
      const chosen = index === null ? null : current?.actions[index] ?? null
      current = null
      emit()
      return chosen
    },
  }
}

export const actionSheetQueue = createActionSheetQueue()

export function showActions(title: string, actions: SheetAction[]) {
  actionSheetQueue.show(title, actions)
}
