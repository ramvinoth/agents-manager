import { useCallback, useRef } from "react"
import { PanResponder, type GestureResponderEvent, type View } from "react-native"
import { useFocusEffect } from "@react-navigation/native"
import { completesBoardSwipe, shouldClaimBoardSwipe } from "./gestures"
import { recordSwipe } from "./usageReporter"

/** The Thread screen's swipe-left-to-open-the-board gesture. `open` navigates;
 *  the hook guards it so a swipe and the menu item can't both push the board,
 *  and re-arms it each time the screen regains focus. Spread `boxProps` on the
 *  transcript box: it measures where the box sits on screen (the claim test
 *  needs its edges) and owns the pan responder. */
export function useBoardSwipe(opts: {
  open: () => void
  enabled: boolean
  isFocused: () => boolean
  /** Changes when the route shows another chat; re-arms the gesture. */
  lifetime: object
}) {
  const { open, enabled, isFocused, lifetime } = opts
  const opening = useRef(false)
  // Set by a blur, a relayout, a second finger or a lost responder; cleared by
  // the next single-finger touch.
  const cancelled = useRef(false)
  const ref = useRef<View>(null)
  const bounds = useRef({ left: 0, width: 0 })
  const generation = useRef(0)
  const measure = useCallback(() => {
    const g = ++generation.current
    ref.current?.measureInWindow((left, _top, width) => {
      if (g === generation.current && width > 0) bounds.current = { left, width }
    })
  }, [])
  const openBoard = useCallback(() => {
    if (opening.current || !isFocused()) return
    opening.current = true
    open()
  }, [open, isFocused])
  // The responder is created once; it reads the latest props through this ref.
  const state = useRef({ openBoard, enabled })
  state.current = { openBoard, enabled }
  useFocusEffect(useCallback(() => {
    opening.current = false
    return () => { cancelled.current = true }
  }, [lifetime]))
  const pan = useRef(PanResponder.create({
    // Bubble phase only: nested code/table scrolling keeps its own responder.
    onMoveShouldSetPanResponder: (_event, g) =>
      state.current.enabled && isFocused() && !opening.current && !cancelled.current
      // g.x0 is only assigned on grant, so during should-set it is still 0;
      // the touch's start point has to be derived from the current position.
      && shouldClaimBoardSwipe({
        ...bounds.current, x0: g.moveX - g.dx, dx: g.dx, dy: g.dy,
        touches: g.numberActiveTouches,
      }),
    onPanResponderMove: (_event, g) => {
      if (g.numberActiveTouches !== 1) cancelled.current = true
    },
    onPanResponderRelease: (_event, g) => {
      if (!cancelled.current && state.current.enabled && completesBoardSwipe(g)) {
        recordSwipe("swipe-board")
        state.current.openBoard()
      }
    },
    onPanResponderTerminate: () => { cancelled.current = true },
  })).current
  const boxProps = {
    ref,
    onLayout: () => {
      bounds.current = { left: 0, width: 0 }
      cancelled.current = true
      measure()
    },
    onTouchStart: (event: GestureResponderEvent) => {
      cancelled.current = event.nativeEvent.touches.length !== 1
      // A layout pass while another screen covers this one (the keyboard
      // opening there resizes our KeyboardAvoidingView) measures a view with
      // no window as zero width, which disables the edge swipe until the next
      // layout. A touch proves the view is on screen, so measure again now.
      measure()
    },
    ...pan.panHandlers,
  }
  return { openBoard, boxProps }
}
