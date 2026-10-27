import { useRef } from "react"
import type { GestureResponderEvent } from "react-native"
import { isTap } from "./gestures"

/**
 * For full-width rows on a swipeable page: their onPress fires only for a real
 * tap, never at the end of a swipe that started on them (see isTap). Spread
 * `onPressIn` on the row and wrap its handler in `tap`. On the pager's edge
 * pages (Chats leftmost, Profile rightmost) a swipe toward the missing page is
 * not taken by the pager, so without this the release lands as a press.
 */
export function useTapGuard() {
  const down = useRef({ x: NaN, y: NaN })
  return {
    onPressIn: (e: GestureResponderEvent) => { down.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY } },
    tap: (fn: () => void) => (e: GestureResponderEvent) => {
      if (isTap(down.current, { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY })) fn()
    },
  }
}
