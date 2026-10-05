import React, { useCallback, type DependencyList, type ReactNode } from "react"
import { View } from "react-native"
import { useFocusEffect } from "@react-navigation/native"

/**
 * The FULL header a screen owns. Every key is required (an `undefined` value
 * still has to be written out) because the six Home tabs share ONE parent-stack
 * header and setOptions MERGES: a key a tab leaves out keeps the previous tab's
 * value — that is how Chats' "+" ended up in Inbox's header. `undefined` means
 * "the navigator default" (the back button on a pushed screen); `() => null`
 * means "explicitly nothing".
 */
export type ScreenHeader = {
  title: string
  headerLeft: (() => ReactNode) | undefined
  headerRight: (() => ReactNode) | undefined
}

type Settable = { setOptions: (options: Partial<ScreenHeader>) => void }

/**
 * Width of the shared header's right slot. It is FIXED on purpose: the tabs
 * reuse one native bar-button view, and iOS keeps that view's origin when only
 * its width changes — Profile's 36pt toggle → Chats' 68pt pair pushed "+" off
 * the screen (measured x=378 on a 402pt screen; react-native-screens' relayout
 * fix, rns PR 2385, did not cure it). A constant width means there is no width change
 * to mis-place. Sized to the widest occupant (Chats' two 32pt icons) so a
 * one-icon tab's glass pill stays snug; anything wider must shrink to fit.
 * A tab with NO right content gets no box at all — an empty fixed box would
 * draw an empty pill (Inbox, Agents).
 */
export const HEADER_RIGHT_WIDTH = 72

/** Re-assert the screen's whole header every time it gains focus. */
export function useScreenHeader(navigation: Settable, header: () => ScreenHeader, deps: DependencyList) {
  useFocusEffect(
    useCallback(() => {
      const h = header()
      const right = h.headerRight?.()
      navigation.setOptions({
        ...h,
        headerRight: h.headerRight && (() => right == null ? null : (
          <View style={{ width: HEADER_RIGHT_WIDTH, flexDirection: "row", alignItems: "center", justifyContent: "center" }}>
            {right}
          </View>
        )),
      })
    }, [navigation, ...deps]) // eslint-disable-line react-hooks/exhaustive-deps
  )
}
