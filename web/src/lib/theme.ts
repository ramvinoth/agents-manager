/**
 * theme.ts — one place that decides light vs dark.
 *
 * Dark is the default: this is a transcript reader that sits beside a terminal
 * and a browser, and it was the only one of the three that opened bright.
 *
 * WHY A NEW STORAGE KEY INSTEAD OF THE OLD "theme" ONE. An earlier build
 * defaulted to light and wrote the resolved value back from an effect that ran
 * on *mount*, not on click:
 *
 *     const [dark, setDark] = useState(() => localStorage.getItem("theme") === "dark")
 *     useEffect(() => { ...; localStorage.setItem("theme", dark ? "dark" : "light") }, [dark])
 *
 * So merely opening the app once stamped `theme=light` into every browser that
 * loaded it. When the default later flipped to dark, the new code read that
 * stamp as "the user picked light" and kept serving a bright page — the dark
 * default was correct in source and dead on arrival in any existing tab.
 *
 * The two cases are byte-identical under the old key: an app-written "light"
 * and a chosen "light" are the same five characters, so no amount of parsing
 * separates them. A fresh key is what makes the distinction exist. The old key
 * is deliberately NOT migrated — migrating it would carry the poison forward,
 * which is the entire bug.
 *
 * The cost is honest and one-time: someone who genuinely preferred light before
 * this change gets dark once, and one click puts it back — this time recorded
 * under a key that only a click ever writes.
 */

/** Versioned on purpose — see the note above about not migrating the old key. */
export const THEME_KEY = "theme.choice"

export type ThemeChoice = "dark" | "light"

/**
 * The user's explicit choice, or null if they have never made one.
 *
 * null is a real and common answer, not an error: it means "nobody has
 * expressed a preference", which is exactly when the dark default applies.
 * Storage can also be unavailable (private mode, blocked cookies) — that is
 * indistinguishable from "no choice yet" for our purposes, so it returns null
 * and the app still renders.
 */
export function readThemeChoice(): ThemeChoice | null {
  try {
    const v = localStorage.getItem(THEME_KEY)
    return v === "dark" || v === "light" ? v : null
  } catch {
    return null
  }
}

/** Persist an explicit choice. Only ever called from a user action. */
export function writeThemeChoice(choice: ThemeChoice): void {
  try {
    localStorage.setItem(THEME_KEY, choice)
  } catch {
    // Unwritable storage costs the preference across reloads, nothing more.
  }
}

/** True when the app should render dark: everything except an explicit "light". */
export function prefersDark(): boolean {
  return readThemeChoice() !== "light"
}

/** Put the resolved theme on <html>, which is what the CSS variants key off. */
export function applyTheme(dark: boolean): void {
  document.documentElement.classList.toggle("dark", dark)
}
