import { useEffect, useState } from "react"
import { useColorScheme } from "react-native"
import { subscribeTheme, themePref, type ThemePref } from "../state/config"
import { effectiveScheme, themeFor, type Theme } from "./theme"

/**
 * The user's theme preference ("system" | "light" | "dark"), kept in sync with
 * the persisted value via the config pub-sub so a change repaints everything.
 */
export function useThemePref(): ThemePref {
  const [pref, setPref] = useState<ThemePref>(themePref())
  useEffect(() => subscribeTheme(() => setPref(themePref())), [])
  return pref
}

/**
 * Resolves the active palette: "system" follows the OS light/dark setting,
 * otherwise the user's forced choice wins. The palette lives in theme.ts
 * (pure + contrast-tested); this hook is only the react-native binding.
 */
export function useTheme(): Theme {
  const pref = useThemePref()
  const os = useColorScheme()
  return themeFor(effectiveScheme(pref, os))
}

export type { Theme }
