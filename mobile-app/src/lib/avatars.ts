/**
 * Session avatars. An avatar is just a short string stored in session meta —
 * one of the emoji below (or empty for "unset"). Rendering everywhere (chat
 * list, thread header, picker) goes through the shared Avatar component so the
 * look stays identical. No image assets are bundled: emoji render natively and
 * the circle colour is derived from the session id, so even an unset session
 * gets a stable, distinct colour instead of everything sharing one accent.
 */

/** The 20 pickable avatars. Kept intentionally varied (faces, animals, objects,
 *  symbols) so sessions are easy to tell apart at a glance. */
export const AVATARS = [
  "🤖", "🦊", "🐧", "🚀", "🐱", "🌟", "🧠", "🦉",
  "🐙", "🦄", "🐢", "🔮", "🌵", "🍄", "🐝", "🦅",
  "🎯", "⚡", "🌈", "🐳",
] as const

/** Palette for the avatar circle background — one is picked deterministically
 *  from the session id so the colour is stable across renders and devices. */
const COLORS = [
  "#ff6a1a", "#e6483d", "#f5a623", "#7e57ff", "#3aa8ff",
  "#22b07d", "#e0407f", "#00b8b8", "#8a63d2", "#d47c1e",
]

/** Stable non-negative hash of a string (djb2). Pure so it can be unit-tested. */
export function hashString(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

/** The circle background colour for a session, derived from its id. */
export function avatarColor(seed: string): string {
  return COLORS[hashString(seed || "") % COLORS.length]
}

/** The glyph to show: the chosen avatar, or a stable default emoji derived from
 *  the id so an un-personalised session still has recognisable imagery. */
export function avatarGlyph(avatar: string | undefined, seed: string): string {
  if (avatar && avatar.trim()) return avatar.trim()
  return AVATARS[hashString(seed || "") % AVATARS.length]
}
