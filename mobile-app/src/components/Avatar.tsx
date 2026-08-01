import React from "react"
import { Text, View, type StyleProp, type ViewStyle } from "react-native"
import { avatarColor, avatarGlyph } from "../lib/avatars"

/**
 * A session's avatar: an emoji glyph centered in a colored circle. The glyph is
 * the session's chosen avatar, or a stable default derived from its id; the
 * circle colour is likewise derived from the id, so every session is visually
 * distinct even before anyone picks one. Used in the chat list, the thread
 * header, and the profile picker so the look is identical everywhere.
 */
export default function Avatar({
  avatar,
  seed,
  size = 46,
  style,
}: {
  /** The chosen avatar string from session meta (may be empty). */
  avatar?: string
  /** Session id (or any stable key) for the default glyph + circle colour. */
  seed: string
  size?: number
  style?: StyleProp<ViewStyle>
}) {
  return (
    <View
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: avatarColor(seed),
          alignItems: "center",
          justifyContent: "center",
        },
        style,
      ]}
    >
      {/* Emoji don't take a tint, so no color prop — the circle carries the hue.
          Font size ~55% of the circle keeps the glyph comfortably inset. */}
      <Text style={{ fontSize: Math.round(size * 0.55) }}>{avatarGlyph(avatar, seed)}</Text>
    </View>
  )
}
