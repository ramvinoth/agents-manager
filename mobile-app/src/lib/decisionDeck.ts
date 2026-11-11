/**
 * The decision deck: the cockpit as a stack of cards the owner swipes —
 * right approves, left denies, a pull past the top or bottom of a card pages
 * to the previous or next one — with round Deny / Comment / Approve buttons
 * doing the same by tap. These are the pure rules the screen wires up.
 */

type Kind = "question" | "plan" | "approval" | "card" | "red"
export type Verdict = "approve" | "deny"

// A drag must travel this far, or be flicked this fast, and be clearly more
// sideways than vertical, before it decides anything.
const TRIGGER = 110
const FLICK_VELOCITY = 800
const MIN_FLICK_TRAVEL = 40
const HORIZONTAL_RATIO = 1.6
// How far past a card's top or bottom edge a pull must go to page.
const OVERSCROLL = 60

/** What a released horizontal drag means: right approves, left denies, else
 *  nothing (the card springs back). vx is points/second. */
export function deckSwipe({ dx, dy, vx }: { dx: number; dy: number; vx: number }): Verdict | null {
  if (![dx, dy, vx].every(Number.isFinite)) return null
  if (Math.abs(dx) <= Math.abs(dy) * HORIZONTAL_RATIO) return null
  const far = Math.abs(dx) >= TRIGGER
  const flick = Math.abs(vx) >= FLICK_VELOCITY && Math.abs(dx) >= MIN_FLICK_TRAVEL && Math.sign(vx) === Math.sign(dx)
  if (!far && !flick) return null
  return dx > 0 ? "approve" : "deny"
}

/** A card's ScrollView released past its edge pages the deck: pulled down
 *  past the top → previous card, pushed up past the bottom → next card. A
 *  card shorter than the screen is all edge, so either pull pages it. */
export function overscrollStep({ offsetY, contentH, viewH }: { offsetY: number; contentH: number; viewH: number }): "next" | "prev" | null {
  if (![offsetY, contentH, viewH].every(Number.isFinite)) return null
  if (offsetY <= -OVERSCROLL) return "prev"
  const bottom = Math.max(0, contentH - viewH)
  if (offsetY >= bottom + OVERSCROLL) return "next"
  return null
}

/**
 * Which round buttons a kind offers. A question has no approve/deny — it is
 * answered by picking its options or writing a reply (the comment button) —
 * so a horizontal swipe on it springs back. Every other kind takes all three.
 */
export function deckActions(kind: Kind): { approve: boolean; deny: boolean; comment: boolean } {
  const verdicts = kind !== "question"
  return { approve: verdicts, deny: verdicts, comment: true }
}

/** What the comment button does for a kind, said to the owner on the sheet. */
export function commentPurpose(kind: Kind): { title: string; hint: string; send: string } {
  switch (kind) {
    case "question":
      return { title: "Reply", hint: "Your words go to the agent as the answer.", send: "Send answer" }
    case "plan":
      return { title: "Ask for changes", hint: "The plan is sent back with your notes so the agent revises it.", send: "Send back" }
    case "card":
      return { title: "Comment on the card", hint: "Posted on the card's thread; the agent is woken to answer.", send: "Post" }
    default:
      return { title: "Message the agent", hint: "Sent to the asking chat. The decision stays open here.", send: "Send" }
  }
}

/** Whether a comment settles the item: a reply answers a question, notes on a
 *  plan deny it for revision, and a comment on a parked card is the owner's
 *  answer to its ask. A message about a tool or Red approval leaves it open. */
export function commentResolves(kind: Kind): boolean {
  return kind === "question" || kind === "plan" || kind === "card"
}

/** The board column a card verdict moves to — the one named Approved or
 *  Declined (any case). null when the card's board has no such column. */
export function verdictColumn(columns: { id: number; name: string }[], verdict: Verdict): number | null {
  const want = verdict === "approve" ? "approved" : "declined"
  const col = columns.find((c) => c.name.trim().toLowerCase() === want)
  return col ? col.id : null
}

// Away this long and coming back counts as opening the app again.
export const AUTO_OPEN_AWAY_MS = 5 * 60 * 1000

/** Open the deck by itself when the owner opens the app with decisions
 *  waiting — on launch (`awayMs` null) or on returning after a real absence —
 *  unless a notification tap is already taking them somewhere specific, or
 *  the deck is already up. */
export function shouldAutoOpenDeck({ count, deepLinkPending, deckOpen, awayMs }: {
  count: number
  deepLinkPending: boolean
  deckOpen: boolean
  awayMs: number | null
}): boolean {
  if (!(count > 0) || deepLinkPending || deckOpen) return false
  return awayMs === null || awayMs >= AUTO_OPEN_AWAY_MS
}
