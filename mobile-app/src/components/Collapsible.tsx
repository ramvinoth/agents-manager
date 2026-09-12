import React, { useMemo, useState } from "react"
import { Pressable, Text, View } from "react-native"
import { collapsePreview } from "../lib/collapse"
import { useTheme } from "../lib/useTheme"
import { useStyles } from "../screens/styles"

/**
 * WhatsApp-style "Show more" for a long message.
 *
 * Owns only the collapse decision and the toggle affordance — `children`
 * receives the text to render, so the user bubble (plain Text) and the agent
 * bubble (Markdown) share this logic instead of each growing their own copy.
 *
 * Expansion is one-way: once the reader has asked for the rest, a re-render
 * (a streaming tick, a pin toggle) must not snap it shut under them. Collapsing
 * again is what scrolling past is for.
 */
export default function Collapsible({
  text,
  children,
}: {
  text: string
  children: (shown: string) => React.ReactNode
}) {
  const t = useTheme()
  const styles = useStyles()
  const [expanded, setExpanded] = useState(false)
  const { collapsed, preview, hiddenLines } = useMemo(() => collapsePreview(text), [text])
  const showToggle = collapsed && !expanded
  return (
    <View>
      {children(showToggle ? preview : text)}
      {collapsed ? (
        <Pressable
          testID="show-more"
          accessibilityRole="button"
          accessibilityLabel={showToggle ? "show-more" : "show-less"}
          onPress={() => setExpanded((e) => !e)}
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
          style={styles.showMoreRow}
        >
          {/* The fade sits directly above the toggle and only while collapsed, so
              the clipped last line reads as "continues" rather than "ended". */}
          {showToggle ? <View style={[styles.showMoreFade, { backgroundColor: t.border }]} /> : null}
          <Text style={[styles.showMoreText, { color: t.accent }]}>
            {showToggle ? `Show more${hiddenLines ? ` · ${hiddenLines} lines` : ""}` : "Show less"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  )
}
