/**
 * The thread's message rows: a user bubble, an agent exchange (final answer with
 * its tool steps and any plans folded underneath), the in-flight placeholder,
 * and the per-step / read-aloud pieces those compose from. Pure presentation —
 * every fact comes in as props from ThreadScreen, which owns the list, the
 * polling and the composer.
 */
import React, { useEffect, useMemo, useRef, useState } from "react"
import { ActivityIndicator, Image, Pressable, Text, TouchableOpacity, View } from "react-native"
import { extractImages, fmtClock, resultToText, type Block, type ImagePart, type ThreadItem, type ToolBlock } from "../lib/thread"
import { splitThinking } from "../lib/thinking"
import { useTheme } from "../lib/useTheme"
import { speak, stopSpeaking } from "../lib/voice"
import SwipeToReply from "./SwipeToReply"
import PlanCard from "./PlanCard"
import Markdown from "./Markdown"
import Collapsible from "./Collapsible"
import Icon from "./Icon"
import ImageViewer from "./ImageViewer"
import { useStyles } from "../lib/styles"
import { shownTitles } from "../lib/canvas"

// The live placeholder shown while a run is in flight. It names the step the
// agent is on ("Running Bash…") and is replaced by the real response when the
// run finishes — the messaging-app equivalent of a pending reply.
export function WorkingBubble({ activity }: { activity: string }) {
  const t = useTheme()
  const styles = useStyles()
  return (
    <View testID="working-bubble" style={[styles.workingBubble, { backgroundColor: t.bubbleAgent }]}>
      <ActivityIndicator size="small" color={t.textMuted} />
      <Text style={[styles.workingText, { color: t.textMuted }]} numberOfLines={1} ellipsizeMode="middle">{activity ? `Running ${activity}…` : "Working on it…"}</Text>
    </View>
  )
}

// The pinned-message banner above the transcript. The screen decides what a tap
// does (jump, then cycle); the count shows position, the close icon unpins.
type Pin = { uuid: string; text: string }
export function PinnedBanner({ items, index, onPress, onUnpin }: {
  items: Pin[]; index: number; onPress: (pin: Pin) => void; onUnpin: (pin: Pin) => void
}) {
  const t = useTheme()
  const styles = useStyles()
  const cur = items[index]
  return (
    <TouchableOpacity
      testID="pinned-banner"
      style={[styles.pinnedBanner, { backgroundColor: t.chipBg, borderBottomColor: t.border }]}
      activeOpacity={0.8}
      onPress={() => onPress(cur)}
    >
      <Icon name="pin" size={15} color={t.accent} />
      <View style={{ flex: 1 }}>
        <Text style={[styles.pinnedBannerLabel, { color: t.accent }]}>
          Pinned{items.length > 1 ? ` · ${index + 1}/${items.length}` : ""}
        </Text>
        <Text style={[styles.pinnedBannerText, { color: t.text }]} numberOfLines={1}>
          {cur.text || "(no text)"}
        </Text>
      </View>
      <TouchableOpacity testID="pinned-banner-unpin" onPress={() => onUnpin(cur)} hitSlop={8}>
        <Icon name="close" size={16} color={t.textMuted} />
      </TouchableOpacity>
    </TouchableOpacity>
  )
}

export function ItemView({
  item,
  isLatest,
  pinnedSet,
  onMessageAction,
  onReply,
  onOpenCanvas,
}: {
  item: ThreadItem
  isLatest?: boolean
  pinnedSet?: string[]
  onMessageAction?: (uuid: string | undefined, text: string, isUser: boolean) => void
  onReply?: (text: string) => void
  onOpenCanvas?: (title: string) => void
}) {
  const t = useTheme()
  const styles = useStyles()
  const isPinned = !!(item.kind !== "system" && item.uuid && pinnedSet?.includes(item.uuid))
  if (item.kind === "system") {
    return (
      <View style={styles.systemPill}>
        <Text style={[styles.systemText, { color: t.textMuted }]}>{item.text}</Text>
      </View>
    )
  }
  if (item.kind === "user") {
    // Long-press offers fork / revert, which cut the session at this message —
    // hence the uuid the parser now preserves.
    return (
      <SwipeToReply onReply={() => onReply?.(item.text)}>
        <View style={[styles.bubbleUser, { backgroundColor: t.bubbleUser }]}>
          {/* onLongPress lives on the selectable Text (not a Touchable wrapper) so
              iOS's native double-tap-to-select still works — a Touchable would
              claim the touch and swallow the selection gesture. */}
          {item.text ? (
            <Collapsible text={item.text}>
              {(shown) => (
                <Text
                  selectable
                  onLongPress={() => onMessageAction?.(item.uuid, item.text, true)}
                  style={[styles.bubbleText, { color: t.text }]}
                >
                  {shown}
                </Text>
              )}
            </Collapsible>
          ) : null}
          {item.images?.length ? <Thumbs images={item.images} /> : null}
          <View style={styles.bubbleMetaRow}>
            {isPinned ? <Icon name="pin" size={11} color={t.accent} /> : null}
            {item.ts ? <Text style={[styles.msgTime, { color: t.textMuted }]}>{fmtClock(item.ts)}</Text> : null}
          </View>
        </View>
      </SwipeToReply>
    )
  }
  return (
    <SwipeToReply onReply={() => onReply?.(item.finalText)}>
      <View>
        {isPinned ? (
          <View style={styles.bubbleMetaRow}>
            <Icon name="pin" size={11} color={t.accent} />
          </View>
        ) : null}
        <ExchangeView
          finalText={item.finalText}
          steps={item.steps}
          plans={item.plans}
          defaultOpen={isLatest}
          ts={item.ts}
          onLongPress={() => onMessageAction?.(item.uuid, item.finalText, false)}
          onOpenCanvas={onOpenCanvas}
        />
      </View>
    </SwipeToReply>
  )
}

// A small "read aloud" speaker button under an agent message: tap to stream the
// message text via TTS (the same Pocket streaming used in voice mode), tap again
// to stop. Self-contained so each message tracks its own play state.
function ReadAloudButton({ text }: { text: string }) {
  const t = useTheme()
  const [playing, setPlaying] = useState(false)
  async function toggle() {
    if (playing) {
      await stopSpeaking()
      setPlaying(false)
      return
    }
    setPlaying(true)
    try {
      await speak(text) // resolves when playback finishes
    } finally {
      setPlaying(false)
    }
  }
  return (
    <TouchableOpacity
      testID="read-aloud"
      accessibilityLabel="read-aloud"
      onPress={toggle}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
    >
      {playing ? (
        <ActivityIndicator size="small" color={t.accent} />
      ) : (
        <Icon name="volume" size={16} color={t.textMuted} />
      )}
    </TouchableOpacity>
  )
}

// An agent exchange: the final response, with the tool-call steps collapsed
// underneath (tap "N steps" to reveal them; each step expands to its result).
export function ExchangeView({
  finalText,
  steps,
  plans,
  defaultOpen,
  ts,
  onLongPress,
  onOpenCanvas,
}: {
  finalText: string
  steps: Block[]
  plans?: ToolBlock[]
  defaultOpen?: boolean
  ts?: string
  onLongPress?: () => void
  onOpenCanvas?: (title: string) => void
}) {
  const t = useTheme()
  const styles = useStyles()
  // Latest exchange defaults open (and stays open while streaming); older ones
  // start collapsed. We track whether the user has manually toggled so their
  // choice isn't overridden by the auto-open below.
  const [open, setOpen] = useState(!!defaultOpen)
  const touched = useRef(false)
  useEffect(() => {
    // When this row (re)becomes the latest — e.g. a fresh turn started — auto
    // open it, unless the user has explicitly toggled it themselves.
    if (defaultOpen && !touched.current) setOpen(true)
    if (!defaultOpen && !touched.current) setOpen(false)
  }, [defaultOpen])
  const toggle = () => {
    touched.current = true
    setOpen((o) => !o)
  }
  const toolCount = useMemo(() => steps.filter((b) => b.kind === "tool").length, [steps])
  // Some models (Qwen3) emit their reasoning inline as <think>…</think> before the
  // answer. Split it out so it renders as a collapsed block and the read-aloud/body
  // only use the actual reply. When there's no <think>, body === finalText.
  const { thinking: think, body } = useMemo(() => splitThinking(finalText), [finalText])
  const [thinkOpen, setThinkOpen] = useState(false)
  // What the agent put on the canvas this turn stays visible even with the steps folded.
  const shown = useMemo(() => (onOpenCanvas ? shownTitles(steps) : []), [steps, onOpenCanvas])
  return (
    <View testID="agent-bubble" style={[styles.bubbleAssistant, { backgroundColor: t.bubbleAgent }]}>
      {/* Steps (tool calls + narration) render ABOVE the final answer: the steps
          are the work, the final text is the conclusion, so reading top-to-bottom
          mirrors how the turn actually unfolded. */}
      {steps.length ? (
        <>
          <TouchableOpacity
            testID="steps-toggle"
            accessibilityLabel="steps-toggle"
            style={styles.stepsToggle}
            onPress={toggle}
          >
            <Icon name={open ? "chevronDown" : "chevronRight"} size={13} color={t.accent} />
            <Text style={[styles.stepsToggleText, { color: t.accent }]}>
              {toolCount || steps.length} {toolCount === 1 ? "step" : "steps"}
            </Text>
          </TouchableOpacity>
          {open ? (
            <View style={[styles.stepsBox, { borderTopColor: t.border }]}>
              {steps.map((b, i) => (
                <StepView key={i} block={b} />
              ))}
            </View>
          ) : null}
        </>
      ) : null}
      {plans?.map((p) => (
        <PlanCard key={p.id} input={p.input} result={p.result} />
      ))}
      {shown.map((title, i) => (
        <Pressable key={title} testID={`canvas-chip-${i}`} accessibilityRole="button"
          accessibilityLabel={`Open canvas ${title}`} onPress={() => onOpenCanvas?.(title)} style={styles.canvasChip}>
          <Icon name="eye" size={14} color={t.accent} />
          <Text numberOfLines={1} style={styles.canvasChipText}>Shown: {title}</Text>
        </Pressable>
      ))}
      {think ? (
        <Pressable onPress={() => setThinkOpen((o) => !o)} style={{ marginTop: steps.length ? 8 : 0 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Icon name={thinkOpen ? "chevronDown" : "chevronRight"} size={14} color={t.textMuted} />
            <Text style={{ color: t.textMuted, fontSize: 12, fontStyle: "italic" }}>Thinking</Text>
          </View>
          {thinkOpen ? (
            <View style={{ marginTop: 4, paddingLeft: 8, borderLeftWidth: 2, borderLeftColor: t.border }}>
              <Text selectable style={{ color: t.textMuted, fontSize: 13, lineHeight: 18 }}>{think}</Text>
            </View>
          ) : null}
        </Pressable>
      ) : null}
      {body ? (
        <View style={steps.length || think ? { marginTop: 8 } : undefined}>
          {/* The current turn is never collapsed: its text is still growing, and a
              bubble that folded itself shut mid-stream would hide the very output
              the reader is watching. Older replies collapse — same rule the steps
              toggle above already follows. */}
          {defaultOpen ? (
            <Markdown text={body} color={t.text} selectable onLongPress={onLongPress} />
          ) : (
            <Collapsible text={body}>
              {(shown) => <Markdown text={shown} color={t.text} selectable onLongPress={onLongPress} />}
            </Collapsible>
          )}
        </View>
      ) : null}
      {!finalText && !steps.length && !plans?.length ? (
        <Text onLongPress={onLongPress} style={[styles.finalText, { color: t.text }]}>…</Text>
      ) : null}
      {/* Footer row: read-aloud speaker first, timestamp pushed to the end. */}
      {ts || body ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4 }}>
          {body ? <ReadAloudButton text={body} /> : null}
          {ts ? <Text style={[styles.msgTime, { color: t.textMuted, marginTop: 0, marginLeft: "auto" }]}>{fmtClock(ts)}</Text> : null}
        </View>
      ) : null}
    </View>
  )
}

function StepView({ block }: { block: Block }) {
  const t = useTheme()
  if (block.kind === "text") {
    return (
      <View style={{ marginVertical: 4 }}>
        <Markdown text={block.text} color={t.textMuted} selectable />
      </View>
    )
  }
  if (block.kind === "compact") return <CompactStep text={block.text} />
  return <ToolStep block={block} />
}

// A context compaction inside the reply: one folded line, the summary on tap.
function CompactStep({ text }: { text: string }) {
  const t = useTheme()
  const [open, setOpen] = useState(false)
  return (
    <View style={{ marginVertical: 4 }}>
      <Pressable testID="compact-step" accessibilityRole="button" accessibilityLabel="Conversation compacted"
        onPress={() => setOpen((o) => !o)} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Icon name="archive" size={13} color={t.textMuted} />
        <Text style={{ color: t.textMuted, fontSize: 12 }}>Conversation compacted</Text>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={13} color={t.textMuted} />
      </Pressable>
      {open ? (
        <View style={{ marginTop: 4, paddingLeft: 8, borderLeftWidth: 2, borderLeftColor: t.border }}>
          <Markdown text={text} color={t.textMuted} selectable />
        </View>
      ) : null}
    </View>
  )
}

// Inline thumbnails; tap one to open it full screen with pinch-zoom and pan.
function Thumbs({ images }: { images: ImagePart[] }) {
  const styles = useStyles()
  const [openAt, setOpenAt] = useState<number | null>(null)
  const uri = (img: ImagePart) => `data:${img.mime};base64,${img.data}`
  return (
    <>
      {images.map((img, i) => (
        <Pressable key={i} testID="chat-image" accessibilityRole="imagebutton" accessibilityLabel="Open image full screen" onPress={() => setOpenAt(i)}>
          <Image style={styles.bubbleImage} resizeMode="cover" source={{ uri: uri(img) }} />
        </Pressable>
      ))}
      {openAt != null && images[openAt] ? <ImageViewer uri={uri(images[openAt])} onClose={() => setOpenAt(null)} /> : null}
    </>
  )
}

// A single tool call: a chip that expands to show the input and result, plus any
// images the tool returned (e.g. screenshots).
function ToolStep({ block }: { block: Extract<Block, { kind: "tool" }> }) {
  const t = useTheme()
  const styles = useStyles()
  const [open, setOpen] = useState(false)
  const result = resultToText(block.result)
  const images = extractImages(block.result)
  const input = block.input == null ? "" : typeof block.input === "string" ? block.input : JSON.stringify(block.input, null, 2)
  return (
    <View style={{ marginVertical: 3 }}>
      <TouchableOpacity
        testID={`tool-${block.name}`}
        accessibilityLabel={`tool-${block.name}`}
        style={[styles.toolChip, { backgroundColor: t.chipBg }, block.isError ? styles.toolChipErr : null]}
        onPress={() => setOpen((o) => !o)}
      >
        <Icon
          name={block.answered ? "check" : block.isError ? "warning" : "tool"}
          size={13}
          color={block.answered ? t.success : block.isError ? t.danger : t.textMuted}
        />
        <Text style={[styles.toolChipText, { color: t.text }]} numberOfLines={1} ellipsizeMode="middle">
          {block.answered ? "You answered" : block.name}
        </Text>
        {block.ts ? <Text style={[styles.toolChipTime, { color: t.textMuted }]}>{fmtClock(block.ts)}</Text> : null}
        <Icon name={open ? "chevronDown" : "chevronRight"} size={12} color={t.textMuted} />
      </TouchableOpacity>
      {open ? (
        <View>
          {input && input !== "{}" ? (
            <View style={[styles.toolResult, { backgroundColor: t.codeBg }]}>
              <Text selectable style={[styles.toolResultText, { color: t.codeText }]}>{input}</Text>
            </View>
          ) : null}
          {result ? (
            <View style={[styles.toolResult, { backgroundColor: t.codeBg }, block.isError ? styles.toolResultErr : null]}>
              <Text selectable style={[styles.toolResultText, { color: t.codeText }]}>
                {result.length > 4000 ? result.slice(0, 4000) + "\n… (truncated)" : result}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}
      {images.length ? <Thumbs images={images} /> : null}
    </View>
  )
}
