// The autoscroll decision for the (inverted) chat list. Newest sits at
// offset 0; scrolling up to read history increases the distance from that
// edge. After any data change — a new message appended, an older page
// prepended, or the opening cached copy swapped for the live tail — the
// list must choose between re-pinning to the newest and leaving the reader
// where they are. The rule is the standard chat one: follow only while the
// reader is still at the bottom; a reader deep in the history is never
// pulled back, and the jump-to-latest button is their way down.
//
// The pin threshold is the same 240pt at which ThreadScreen shows the
// jump button, so the list pins exactly while that button is hidden — the
// two can never disagree, and a "slightly above the bottom" reader (button
// hidden) still follows the run, which is what a live session expects.
export const PIN_THRESHOLD = 240

export const shouldPinToNewest = (distanceFromBottom: number, threshold = PIN_THRESHOLD): boolean =>
  distanceFromBottom <= threshold
