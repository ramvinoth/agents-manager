import { useCallback, useEffect, useRef, useState } from "react"
import { Animated } from "react-native"
import { fmtDate, type ThreadItem } from "./thread"

type Viewable = { item: unknown; index: number | null }

/**
 * WhatsApp-style floating day header for an INVERTED thread list: the date of
 * the topmost visible message, shown while scrolling and faded out ~1s after
 * scrolling stops. `isRow` filters out non-message rows (the working bubble).
 * Pass `onViewableItemsChanged` and `viewabilityConfig` to the FlatList as-is
 * (they are stable refs, since FlatList forbids changing them at runtime) and
 * call `revealDate` from onScroll.
 */
export function useScrollDatePill(isRow: (item: unknown) => item is ThreadItem) {
  const [scrollDate, setScrollDate] = useState("")
  const dateOpacity = useRef(new Animated.Value(0)).current
  const dateHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dateShown = useRef(false)

  // Called on every scroll frame: start the fade-in once, then only push the
  // hide timer back, so a scroll doesn't restart an animation 60 times a second.
  const revealDate = useCallback(() => {
    if (!dateShown.current) {
      dateShown.current = true
      dateOpacity.stopAnimation()
      Animated.timing(dateOpacity, { toValue: 1, duration: 120, useNativeDriver: true }).start()
    }
    if (dateHideTimer.current) clearTimeout(dateHideTimer.current)
    dateHideTimer.current = setTimeout(() => {
      dateShown.current = false
      Animated.timing(dateOpacity, { toValue: 0, duration: 350, useNativeDriver: true }).start()
    }, 1000)
  }, [dateOpacity])

  useEffect(() => {
    return () => {
      if (dateHideTimer.current) clearTimeout(dateHideTimer.current)
    }
  }, [])

  // The row at the TOP of the screen is the one with the highest data index
  // (index 0 sits at the bottom of an inverted list).
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 10 }).current
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: Viewable[] }) => {
    let top: ThreadItem | undefined
    let topIndex = -1
    for (const v of viewableItems) {
      if (!isRow(v.item)) continue
      if ((v.index ?? -1) > topIndex) {
        topIndex = v.index ?? -1
        top = v.item
      }
    }
    const d = top ? fmtDate(top.ts) : ""
    if (d) setScrollDate(d)
  }).current

  return { scrollDate, dateOpacity, revealDate, onViewableItemsChanged, viewabilityConfig }
}
