import React, { useMemo } from "react"
import { Linking, ScrollView, Text, View } from "react-native"
import { parseMarkdown, type MdBlock, type Span } from "../lib/markdown"
import { texToUnicode } from "../lib/texUnicode"
import { useTheme, type Theme } from "../lib/useTheme"
import { useStyles } from "../screens/styles"
import MermaidView from "./MermaidView"
import MathView from "./MathView"

/** Whether a #rrggbb background is dark (perceived luminance < 0.5). Used to pick
 *  the mermaid diagram theme since Theme carries no explicit dark flag. */
function isDarkBg(hex: string): boolean {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex || "")
  if (!m) return false
  const n = parseInt(m[1], 16)
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5
}

/**
 * Renders the markdown that agent replies are written in. Parsing lives in
 * lib/markdown.ts (pure + unit-tested); this file is only presentation.
 *
 * `color` sets the body-text colour (the bubble supplies it so text stays
 * legible on its background); code blocks and tables theme themselves off the
 * OS light/dark setting so they never render as a bright panel in dark mode.
 */
export default function Markdown({
  text,
  color,
  selectable,
  onLongPress,
}: {
  text: string
  color?: string
  selectable?: boolean
  onLongPress?: () => void
}) {
  const blocks = useMemo(() => parseMarkdown(text), [text])
  const t = useTheme()
  return (
    <View>
      {blocks.map((b, i) => (
        <Block key={i} b={b} color={color} t={t} selectable={selectable} onLongPress={onLongPress} />
      ))}
    </View>
  )
}

function Inline({
  spans,
  style,
  selectable,
  onLongPress,
}: {
  spans: Span[]
  style?: any
  selectable?: boolean
  onLongPress?: () => void
}) {
  const styles = useStyles()
  return (
    <Text style={style} selectable={selectable} onLongPress={onLongPress}>
      {spans.map((s, i) => {
        if (s.t === "bold") return <Text key={i} style={styles.mdBold}>{s.s}</Text>
        if (s.t === "italic") return <Text key={i} style={styles.mdItalic}>{s.s}</Text>
        if (s.t === "code") return <Text key={i} style={styles.mdCodeInline}>{s.s}</Text>
        if (s.t === "math") {
          // Inline math: show Unicode when the TeX is simple enough (keeps native
          // text selection); otherwise fall back to the monospace source so a
          // complex formula is at least legible (display math uses the WebView).
          const u = texToUnicode(s.s)
          return <Text key={i} style={u ? styles.mdItalic : styles.mdCodeInline}>{u ?? s.s}</Text>
        }
        if (s.t === "link")
          return (
            <Text key={i} style={styles.mdLink} onPress={() => { if (s.href) Linking.openURL(s.href).catch(() => {}) }}>
              {s.s}
            </Text>
          )
        return <Text key={i}>{s.s}</Text>
      })}
    </Text>
  )
}

function Block({ b, color, t, selectable, onLongPress }: { b: MdBlock; color?: string; t: Theme; selectable?: boolean; onLongPress?: () => void }) {
  const styles = useStyles()
  const base = color ? [styles.mdText, { color }] : styles.mdText

  switch (b.t) {
    case "h":
      return (
        <Inline
          spans={b.spans}
          selectable={selectable}
          onLongPress={onLongPress}
          style={[styles.mdText, b.level <= 2 ? styles.mdH1 : styles.mdH3, color ? { color } : null]}
        />
      )
    case "code":
      // Mermaid fences render as a diagram (WebView); everything else stays a
      // horizontally-scrollable code block. A failed diagram shows "Diagram error"
      // inside the WebView, so a broken graph never blanks the message.
      if ((b.lang || "").toLowerCase() === "mermaid") {
        // Derive dark from the palette's background luminance (no scheme flag on
        // Theme). Dark bg → dark mermaid theme.
        const dark = isDarkBg(t.bg)
        return <MermaidView source={b.text} dark={dark} textColor={t.text} />
      }
      // Horizontal scroll rather than wrapping — wrapped code is unreadable.
      return (
        <View style={[styles.mdCodeBlock, { backgroundColor: t.codeBg }]}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.mdScroll}>
            <Text style={[styles.mdCodeText, { color: t.codeText }]} selectable={selectable} onLongPress={onLongPress}>{b.text}</Text>
          </ScrollView>
        </View>
      )
    case "li":
      return (
        <View style={[styles.mdLi, { marginLeft: 4 + b.depth * 16 }]}>
          <Text style={[styles.mdText, styles.mdBullet, color ? { color } : null]}>{b.marker}</Text>
          <Inline spans={b.spans} selectable={selectable} onLongPress={onLongPress} style={[base, { flex: 1 }]} />
        </View>
      )
    case "table":
      // Scrolls sideways so wide tables stay aligned instead of collapsing.
      return (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={[styles.mdTableWrap, styles.mdScroll]}>
          <View>
            <View style={[styles.mdRow, styles.mdHeadRow, { borderBottomColor: t.border }]}>
              {b.header.map((h, i) => (
                <Text key={i} style={[styles.mdCell, styles.mdHeadCell, { color: t.text, borderRightColor: t.border }]} numberOfLines={2}>
                  {h}
                </Text>
              ))}
            </View>
            {b.rows.map((r, ri) => (
              <View key={ri} style={styles.mdRow}>
                {r.map((c, ci) => (
                  <Text key={ci} selectable={selectable} onLongPress={onLongPress} style={[styles.mdCell, { color: color || t.text, borderRightColor: t.border }]}>
                    {c}
                  </Text>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      )
    case "quote":
      return (
        <View style={styles.mdQuote}>
          <Inline spans={b.spans} selectable={selectable} onLongPress={onLongPress} style={[styles.mdText, styles.mdQuoteText, color ? { color } : null]} />
        </View>
      )
    case "hr":
      return <View style={styles.mdHr} />
    case "mathblock":
      // Display equation → full-fidelity KaTeX in a WebView (bundled offline).
      return <MathView tex={b.text} dark={isDarkBg(t.bg)} textColor={color || t.text} />
    default:
      return <Inline spans={b.spans} selectable={selectable} onLongPress={onLongPress} style={[base, styles.mdPara]} />
  }
}
