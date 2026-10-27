// Local UX thresholds shared by the app's edge swipes (the transcript's board
// swipe, the Chats tab's menu swipe) and their tests.
const EDGE = 32
const ACTIVATION = 14
const TRIGGER = 56
const HORIZONTAL_RATIO = 1.6

type Swipe = { dx: number; dy: number }

export function shouldClaimBoardSwipe({
  x0, left, width, dx, dy, touches,
}: Swipe & { x0: number; left: number; width: number; touches: number }): boolean {
  return [x0, left, width, dx, dy].every(Number.isFinite)
    && width > EDGE && touches === 1
    && x0 >= left + width - EDGE && x0 <= left + width
    && dx < -ACTIVATION && -dx > Math.abs(dy) * HORIZONTAL_RATIO
}

// Evaluate the final displacement, not whether a drag crossed the threshold once.
export function completesBoardSwipe({ dx, dy }: Swipe): boolean {
  return Number.isFinite(dx) && Number.isFinite(dy)
    && dx <= -TRIGGER && -dx > Math.abs(dy) * HORIZONTAL_RATIO
}

// The Chats tab is the leftmost page, so a rightward drag there has nowhere to
// page to; it opens the side menu instead. Same thresholds as the board swipe,
// mirrored.
export function completesMenuSwipe({ dx, dy }: Swipe): boolean {
  return Number.isFinite(dx) && Number.isFinite(dy)
    && dx >= TRIGGER && dx > Math.abs(dy) * HORIZONTAL_RATIO
}

// How far open the side menu is while a finger drags it: 0 shut, 1 fully out.
export function menuDragProgress(dx: number, panelWidth: number): number {
  if (!Number.isFinite(dx) || !(panelWidth > 0)) return 0
  return Math.min(1, Math.max(0, dx / panelWidth))
}

// On release the menu settles open for a completed swipe or a quick rightward
// flick (a thumb rarely travels far), and shut otherwise. vx is points/second.
const FLICK_VELOCITY = 500
export function menuSettlesOpen({ dx, dy, vx }: Swipe & { vx: number }): boolean {
  if (completesMenuSwipe({ dx, dy })) return true
  return Number.isFinite(vx) && vx >= FLICK_VELOCITY && dx > ACTIVATION && dx > Math.abs(dy) * HORIZONTAL_RATIO
}

// A press is a tap only if the finger lifted near where it went down. React
// Native's touchables count any release inside the element as a press, so on a
// full-width row a short horizontal swipe (to page, or to pull the menu) would
// land as a tap and open the row. 10pt is iOS's own tap slop.
const TAP_SLOP = 10
type Point = { x: number; y: number }
export function isTap(down: Point, up: Point): boolean {
  return [down.x, down.y, up.x, up.y].every(Number.isFinite)
    && Math.abs(up.x - down.x) <= TAP_SLOP && Math.abs(up.y - down.y) <= TAP_SLOP
}
