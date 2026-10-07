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
