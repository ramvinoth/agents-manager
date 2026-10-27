/**
 * CanvasScreen — what an agent showed the owner in one session (server:
 * viewer/routes/canvas.py; the agent writes with the canvas_show MCP tool).
 * Opened from the thread's "Canvas" menu item or a "Shown: <title>" chip under
 * the agent's reply. Tabs pick a canvas; the view renders by kind: markdown,
 * mermaid, slides (prev/next, dots, or a horizontal swipe) or html (a WebView with
 * scripts, its own cookie jar, no navigation away, the app's colours as defaults). Re-read every few seconds while focused, so an
 * agent's revision replaces the old version in place.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ActivityIndicator, Alert, Linking, Pressable, ScrollView, Text, View } from "react-native"
import { useFocusEffect } from "@react-navigation/native"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import { WebView } from "react-native-webview"
import type { RootStackParamList } from "../../App"
import { api } from "../api/client"
import { KIND_LABEL, noteBody, queueReply, replyDraft, splitSlides, themedHtml, type Canvas, type CanvasKind, type CanvasMeta } from "../lib/canvas"
import { fmtWaiting } from "../lib/decisions"
import { userError } from "../lib/errors"
import { useTheme } from "../lib/useTheme"
import { useStyles } from "../lib/styles"
import MermaidView from "../components/MermaidView"
import Markdown, { isDarkBg } from "../components/Markdown"
import Icon, { type IconName } from "../components/Icon"

type Props = NativeStackScreenProps<RootStackParamList, "Canvas">

const POLL_MS = 5000
const KIND_ICON: Record<CanvasKind, IconName> = { markdown: "file", mermaid: "fork", html: "code", slides: "play" }
// A slide swipe: mostly horizontal and long enough not to be a tap or a scroll.
const SWIPE_PX = 50
const age = (at: number) => { const w = fmtWaiting(Date.now() / 1000 - at); return w === "now" ? "just now" : `${w} ago` }

export default function CanvasScreen({ navigation, route }: Props) {
  const t = useTheme()
  const styles = useStyles()
  const { session, title: chatTitle, initial } = route.params
  const [list, setList] = useState<CanvasMeta[] | null>(null)
  const [selected, setSelected] = useState(initial || "")
  const [canvas, setCanvas] = useState<Canvas | null>(null)
  const [slide, setSlide] = useState(0)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const request = useRef(0)
  const touch = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => { navigation.setOptions({ title: `Canvas · ${chatTitle}` }) }, [navigation, chatTitle])

  const loadList = useCallback(async () => {
    try {
      const r = await api.canvasList(session)
      setList(r.canvases); setError("")
    } catch (e) {
      setError(userError(e, "the canvases"))
    }
  }, [session])
  useFocusEffect(useCallback(() => {
    void loadList()
    const timer = setInterval(() => void loadList(), POLL_MS)
    return () => clearInterval(timer)
  }, [loadList]))

  // The asked-for canvas when it exists, else the newest; a deleted one falls back too.
  const current = useMemo(() => {
    if (!list?.length) return null
    return list.find((c) => c.title === selected)
      ?? list.reduce((a, b) => (b.updated_at > a.updated_at ? b : a))
  }, [list, selected])

  // Read the content only when the canvas or its version changes, not every poll.
  useEffect(() => {
    if (!current) { setCanvas(null); return }
    if (canvas && canvas.title === current.title && canvas.version === current.version) return
    const n = ++request.current
    api.canvasRead(session, current.title)
      .then((c) => {
        if (n !== request.current) return
        if (canvas?.title !== c.title) setSlide(0)
        setCanvas(c)
      })
      .catch((e) => { if (n === request.current) setError(userError(e, "the canvas")) })
  }, [session, current?.title, current?.version]) // eslint-disable-line react-hooks/exhaustive-deps

  const slides = canvas?.kind === "slides" ? splitSlides(canvas.content) : null
  const at = slides ? Math.min(slide, slides.length - 1) : 0
  const many = !!slides && slides.length > 1
  function swipe(dx: number, dy: number) {
    if (!slides || Math.abs(dx) < SWIPE_PX || Math.abs(dx) < 1.5 * Math.abs(dy)) return
    setSlide(Math.max(0, Math.min(slides.length - 1, at + (dx < 0 ? 1 : -1))))
  }

  function reply() {
    if (!canvas) return
    queueReply(session, replyDraft(canvas, slides ? { index: at, count: slides.length } : undefined))
    navigation.goBack()
  }
  async function saveNote() {
    if (!canvas) return
    try {
      await api.orgCreateNote({ title: canvas.title, body: noteBody(canvas), session })
      setNotice(`Saved "${canvas.title}" to this chat's notes.`)
    } catch (e) {
      setNotice(userError(e, "the note", "save"))
    }
  }
  function remove() {
    if (!canvas) return
    const name = canvas.title
    Alert.alert(`Delete "${name}"?`, "The agent can show it again, but this version is gone.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: async () => {
        try {
          await api.canvasDelete(session, name)
          setCanvas(null); setSelected(""); setNotice("")
          await loadList()
        } catch (e) {
          setNotice(userError(e, "the canvas", "delete"))
        }
      } },
    ])
  }

  if (error && !list) {
    return (
      <View testID="canvas-error" style={[styles.page, styles.mapContent]}>
        <View style={styles.mapErrorBox}>
          <Text style={styles.mapBody}>{error}</Text>
          <Pressable accessibilityRole="button" onPress={() => void loadList()}>
            <Text style={styles.mapLink}>Try again</Text>
          </Pressable>
        </View>
      </View>
    )
  }
  if (!list) {
    return (
      <View style={[styles.page, styles.mapLoading]}>
        <ActivityIndicator accessibilityLabel="Loading canvases" />
      </View>
    )
  }
  if (!list.length) {
    return (
      <View testID="canvas-empty" style={[styles.page, styles.mapLoading]}>
        <Text style={styles.mapInstallTitle}>Nothing shown yet</Text>
        <Text style={[styles.mapHint, { textAlign: "center" }]}>
          When the agent wants to show you a plan, a diagram or a mock-up, it opens here.
        </Text>
      </View>
    )
  }

  return (
    <View style={styles.page}>
      {list.length > 1 ? (
        <View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.canvasTabs}>
            {list.map((c, i) => {
              const on = c.title === current?.title
              return (
                <Pressable key={c.title} testID={`canvas-tab-${i}`} accessibilityRole="tab"
                  accessibilityState={{ selected: on }} onPress={() => { setSelected(c.title); setNotice("") }}
                  style={[styles.canvasTab, on ? styles.canvasTabOn : null]}>
                  <Icon name={KIND_ICON[c.kind]} size={13} color={on ? t.bg : t.textMuted} />
                  <Text numberOfLines={1} style={[styles.canvasTabText, on ? styles.canvasTabTextOn : null]}>{c.title}</Text>
                </Pressable>
              )
            })}
          </ScrollView>
        </View>
      ) : null}
      {current ? (
        <View style={styles.canvasHead}>
          <Text style={styles.canvasTitle} numberOfLines={2}>{current.title}</Text>
          <Text style={[styles.canvasMeta, { paddingHorizontal: 0 }]} numberOfLines={1}>
            {KIND_LABEL[current.kind]} · v{current.version} · {age(current.updated_at)}
          </Text>
        </View>
      ) : null}

      <View style={styles.flex1}>
        {!canvas ? (
          <View style={styles.mapLoading}><ActivityIndicator accessibilityLabel="Opening the canvas" /></View>
        ) : canvas.kind === "html" ? (
          <WebView
            testID="canvas-html"
            style={styles.canvasWeb}
            originWhitelist={["about:*"]}
            source={{ html: themedHtml(canvas.content, { bg: t.bg, fg: t.text, dark: isDarkBg(t.bg) }) }}
            javaScriptEnabled
            incognito
            // The page may run its own scripts but never navigates the view away;
            // a link the owner taps opens in the browser instead.
            onShouldStartLoadWithRequest={(r) => {
              if (r.url.startsWith("about:") || r.isTopFrame === false) return true
              if (r.navigationType === "click") void Linking.openURL(r.url)
              return false
            }}
          />
        ) : (
          <ScrollView contentContainerStyle={[styles.canvasBody, slides ? styles.canvasSlide : null]}
            onTouchStart={(e) => { touch.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY } }}
            onTouchEnd={(e) => {
              const s = touch.current
              touch.current = null
              if (s) swipe(e.nativeEvent.pageX - s.x, e.nativeEvent.pageY - s.y)
            }}>
            {canvas.kind === "mermaid" ? (
              <MermaidView source={canvas.content} dark={isDarkBg(t.bg)} textColor={t.text} />
            ) : (
              <Markdown text={slides ? slides[at] : canvas.content} color={t.text} selectable />
            )}
          </ScrollView>
        )}
      </View>

      {many && slides ? (
        <View style={styles.canvasSlideNav}>
          <Pressable testID="canvas-prev" accessibilityRole="button" accessibilityLabel="Previous slide"
            disabled={at === 0} onPress={() => setSlide(at - 1)} style={styles.canvasBarBtn}>
            <Icon name="chevronLeft" size={16} color={at === 0 ? t.textMuted : t.accent} />
            <Text style={[styles.canvasBarText, at === 0 ? { color: t.textMuted } : null]}>Previous</Text>
          </Pressable>
          <Text testID="canvas-slide-pos" style={styles.canvasMeta}
            accessibilityLabel={`Slide ${at + 1} of ${slides.length}`}>{at + 1} / {slides.length}</Text>
          <Pressable testID="canvas-next" accessibilityRole="button" accessibilityLabel="Next slide"
            disabled={at === slides.length - 1} onPress={() => setSlide(at + 1)} style={styles.canvasBarBtn}>
            <Text style={[styles.canvasBarText, at === slides.length - 1 ? { color: t.textMuted } : null]}>Next</Text>
            <Icon name="chevronRight" size={16} color={at === slides.length - 1 ? t.textMuted : t.accent} />
          </Pressable>
        </View>
      ) : null}

      {notice ? <Text testID="canvas-notice" style={[styles.canvasMeta, { paddingVertical: 4 }]}>{notice}</Text> : null}
      <View style={styles.canvasBar}>
        <Pressable testID="canvas-reply" accessibilityRole="button" disabled={!canvas} onPress={reply} style={styles.canvasBarBtn}>
          <Icon name="reply" size={16} color={t.accent} />
          <Text style={styles.canvasBarText}>Reply</Text>
        </Pressable>
        <Pressable testID="canvas-save-note" accessibilityRole="button" disabled={!canvas} onPress={() => void saveNote()} style={styles.canvasBarBtn}>
          <Icon name="book" size={16} color={t.accent} />
          <Text style={styles.canvasBarText}>Save as note</Text>
        </Pressable>
        <Pressable testID="canvas-delete" accessibilityRole="button" disabled={!canvas} onPress={remove} style={styles.canvasBarBtn}>
          <Icon name="trash" size={16} color={t.danger} />
          <Text style={[styles.canvasBarText, { color: t.danger }]}>Delete</Text>
        </Pressable>
      </View>
    </View>
  )
}
