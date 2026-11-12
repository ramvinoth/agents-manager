import type { Scheme } from "./theme.ts"

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

/** One identity colour set per agent hue. `fill` is the avatar circle; `text`
 *  is the name colour on a bubble, tuned per scheme so it clears WCAG AA (4.5:1)
 *  on both the light and dark bubble. Muted on purpose: neon hues vibrate and
 *  fail contrast. The avatar and the chat name share ONE entry, so an agent has
 *  one colour on every screen. */
export const AGENT_HUES = [
  { fill: "#b45309", text: { light: "#a04a00", dark: "#f0b35c" } }, // amber
  { fill: "#0f766e", text: { light: "#0c6a63", dark: "#5fd3c6" } }, // teal
  { fill: "#6d4bc4", text: { light: "#6240b8", dark: "#bfa8f7" } }, // violet
  { fill: "#be185d", text: { light: "#b0174f", dark: "#f58fb8" } }, // rose
  { fill: "#1d5fb8", text: { light: "#1a56a8", dark: "#86b8f5" } }, // blue
  { fill: "#3f7d1a", text: { light: "#356a0d", dark: "#9fd66f" } }, // green
  { fill: "#c2410c", text: { light: "#b23a08", dark: "#f7a07c" } }, // rust
  { fill: "#0e7490", text: { light: "#0b6a85", dark: "#6fcbe3" } }, // cyan
  { fill: "#8a3b7a", text: { light: "#82336f", dark: "#e29bd3" } }, // plum
  { fill: "#5b6b1f", text: { light: "#556319", dark: "#c3d46a" } }, // olive
] as const

/** The one colour authority. `seed` is the agent's session id (system: "system"). */
export function agentHue(seed: string): (typeof AGENT_HUES)[number] {
  return AGENT_HUES[hashString(seed || "") % AGENT_HUES.length]
}

/** The name colour for an agent on a bubble in the given scheme. */
export function agentNameColor(seed: string, scheme: Scheme): string {
  return agentHue(seed).text[scheme]
}

/** Stable non-negative hash of a string (djb2). Pure so it can be unit-tested. */
export function hashString(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

/** The circle background colour for a session, derived from its id. */
export function avatarColor(seed: string): string {
  return agentHue(seed).fill
}

/** The glyph to show: the chosen avatar, or a stable default emoji derived from
 *  the id so an un-personalised session still has recognisable imagery. */
export function avatarGlyph(avatar: string | undefined, seed: string): string {
  if (avatar && avatar.trim()) return avatar.trim()
  return AVATARS[hashString(seed || "") % AVATARS.length]
}
