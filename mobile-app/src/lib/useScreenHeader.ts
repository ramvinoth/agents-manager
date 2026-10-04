import { useCallback, type DependencyList, type ReactNode } from "react"
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

/** Re-assert the screen's whole header every time it gains focus. */
export function useScreenHeader(navigation: Settable, header: () => ScreenHeader, deps: DependencyList) {
  useFocusEffect(
    useCallback(() => navigation.setOptions(header()), [navigation, ...deps]) // eslint-disable-line react-hooks/exhaustive-deps
  )
}
