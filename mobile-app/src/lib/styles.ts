import { Platform, StyleSheet } from "react-native"
import { MONO_FONT as mono } from "./fonts"
import { buildScreenStyles } from "./screenStyles"
import { useTheme } from "./useTheme"
import type { Theme } from "./theme"

/**
 * The app's stylesheet, as a factory over the active theme. Backgrounds, text,
 * borders, inputs, code, chips etc. resolve from the palette (src/lib/theme.ts)
 * so every screen follows light/dark automatically — this is what stops white
 * pages leaking in dark mode. The palette is intentionally muted/pastel (sage
 * accent, clay danger, warm sand cards) rather than neon so it reads as crafted,
 * not generic. Every colour here is a palette token — including the sand
 * "waiting on you" cards (attention*) and text on accent fills (onAccent) —
 * so nothing is hardcoded per screen; the only literals are shadow black and
 * translucent scrims, which are colour-neutral.
 *
 * Consume via the `useStyles()` hook (below), not a module-level `styles`, so a
 * theme change repaints. makeStyles is memoised per Theme (LIGHT/DARK are stable
 * singletons) so StyleSheet.create runs at most twice.
 */
function buildCoreStyles(t: Theme) {
  return StyleSheet.create({
    screen: { flex: 1, padding: 16, backgroundColor: t.bg },
    page: { flex: 1, backgroundColor: t.bg },
    flex1: { flex: 1 },
    textCenter: { textAlign: "center" },
    emptyItalic: { color: t.textMuted, fontStyle: "italic" },
    faded: { opacity: 0.5 },
    rowCenter: { flexDirection: "row", alignItems: "center" },
    // Header/toolbar icon controls (components/HeaderButton) and their row.
    headerIcons: { flexDirection: "row", alignItems: "center", gap: 2 },
    headerBtn: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
    center: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: t.bg },
    label: { fontSize: 13, fontWeight: "600", color: t.text, marginTop: 12, marginBottom: 6 },
    hint: { fontSize: 12, color: t.textMuted, marginTop: 8 },
    error: { color: t.danger, marginTop: 12 },
    errorBanner: { color: t.danger, padding: 12 },
    infoBanner: { color: t.textMuted, padding: 12 },
    input: {
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 15,
      color: t.text,
      backgroundColor: t.inputBg,
    },
    button: {
      backgroundColor: t.accent,
      borderRadius: 8,
      paddingVertical: 14,
      alignItems: "center",
      marginTop: 20,
    },
    buttonText: { color: t.onAccent, fontSize: 16, fontWeight: "600" },
    rowSub: { fontSize: 12, color: t.textMuted, marginTop: 2 },
    pill: {
      backgroundColor: t.chipBg,
      borderRadius: 14,
      paddingHorizontal: 12,
      paddingVertical: 6,
      marginLeft: 8,
    },
    pillText: { fontSize: 13, color: t.text, fontWeight: "500" },
    // Tab screens (Hosts / Projects / Profile)
    profileInfoRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 18,
      paddingVertical: 12,
      gap: 12,
    },
    profileInfoLabel: { fontSize: 14, color: t.textMuted },
    profileInfoValue: { flex: 1, textAlign: "right", fontSize: 14 },
    // WhatsApp-style chat list
    chatRow: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border,
      gap: 12,
    },
    avatar: {
      width: 46,
      height: 46,
      borderRadius: 23,
      backgroundColor: t.accent,
      alignItems: "center",
      justifyContent: "center",
    },
    chatName: { fontSize: 16, fontWeight: "600", color: t.text },
    chatSub: { fontSize: 13, color: t.textMuted, marginTop: 2 },
    chatTime: { fontSize: 12, color: t.textMuted },
    chatNameUnread: { fontWeight: "800" },
    chatTimeUnread: { color: t.accent, fontWeight: "700" },
    chatMetaCol: { alignItems: "flex-end", gap: 5 },
    unreadDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: t.accent },
    // Live-run dot: a run is in flight for this session (emerald, matches web).
    runningDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: t.success },
    // Active-filter pill (Chats search) + archived reveal row (Chats list header).
    filterChip: {
      paddingHorizontal: 14,
      paddingVertical: 6,
      borderRadius: 16,
      backgroundColor: t.chipBg,
    },
    filterChipActive: { backgroundColor: t.accent },
    filterChipText: { fontSize: 13, fontWeight: "600", color: t.textMuted },
    filterChipTextActive: { color: t.onAccent },
    archivedRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: t.border,
    },
    archivedRowText: { fontSize: 15, fontWeight: "600", color: t.text },
    // Collapsible project group header (Projects chip view).
    projectHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 16,
      paddingVertical: 9,
      backgroundColor: t.chipBg,
      borderBottomWidth: 1,
      borderBottomColor: t.border,
    },
    projectHeaderText: { flex: 1, fontSize: 13, fontWeight: "700", color: t.textMuted, textTransform: "uppercase", letterSpacing: 0.5 },
    projectHeaderCount: { fontSize: 13, fontWeight: "600", color: t.textMuted },
    // AskUserQuestion quick-reply card — attention family ("the agent is
    // waiting on you").
    auqCard: {
      marginTop: 8,
      padding: 10,
      borderRadius: 10,
      backgroundColor: t.attentionBg,
      borderWidth: 1,
      borderColor: t.attentionBorder,
    },
    auqHeader: { flexDirection: "row", alignItems: "center", gap: 5, marginBottom: 2 },
    auqHeaderText: { fontSize: 12, fontWeight: "700", color: t.attentionMuted },
    auqQuestion: { fontSize: 14.5, fontWeight: "600", color: t.attentionText, marginBottom: 6 },
    auqOptions: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
    auqChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 16,
      backgroundColor: t.inputBg,
      borderWidth: 1,
      borderColor: t.attentionBorder,
    },
    auqChipPicked: { backgroundColor: t.accent, borderColor: t.accent },
    auqChipText: { fontSize: 13.5, fontWeight: "600", color: t.attentionText },
    auqChipTextPicked: { color: t.onAccent },
    auqDesc: { fontSize: 12, color: t.attentionMuted, marginTop: 6 },
    auqNote: {
      marginTop: 10,
      minHeight: 40,
      paddingHorizontal: 10,
      paddingVertical: 8,
      borderRadius: 8,
      backgroundColor: t.inputBg,
      borderWidth: 1,
      borderColor: t.attentionBorder,
      fontSize: 13.5,
      color: t.attentionText,
    },
    auqSubmit: {
      marginTop: 10,
      paddingVertical: 9,
      borderRadius: 8,
      backgroundColor: t.accent,
      alignItems: "center",
    },
    auqSubmitText: { color: t.onAccent, fontSize: 14, fontWeight: "700" },
    // In-thread search bar
    threadSearchBar: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 10,
      paddingVertical: 6,
      backgroundColor: t.surface,
    },
    threadSearchInput: {
      flex: 1,
      height: 34,
      borderRadius: 17,
      paddingHorizontal: 12,
      fontSize: 14,
      color: t.text,
      backgroundColor: t.inputBg,
    },
    threadSearchCount: { fontSize: 12, minWidth: 44, textAlign: "center", color: t.textMuted },
    // Hamburger drawer (the mobile "left-hand column")
    drawerCheckRow: { flexDirection: "row", alignItems: "center", gap: 6 },
    // Theme switch (System / Light / Dark) segmented control
    segRow: { flexDirection: "row", gap: 6, paddingHorizontal: 18, marginTop: 6 },
    seg: {
      flex: 1,
      alignItems: "center",
      paddingVertical: 7,
      borderRadius: 9,
      backgroundColor: t.chipBg,
      borderWidth: 1,
      borderColor: t.border,
    },
    segActive: { backgroundColor: t.accent, borderColor: t.accent },
    segText: { fontSize: 12.5, fontWeight: "600", color: t.textMuted },
    segTextActive: { color: t.onAccent, fontWeight: "700" },
    // Chat thread (bubbles)
    threadList: { flex: 1, backgroundColor: t.thread },
    // The thread list is `inverted`, which flips the content container — so
    // paddingTop applies at the visual BOTTOM and paddingBottom at the visual
    // TOP. Values are set for the visual result: 24px of breathing room under
    // the newest message (above the composer), 8px at the top.
    threadContent: { paddingTop: 24, paddingBottom: 8 },
    bubbleUser: {
      alignSelf: "flex-end",
      backgroundColor: t.bubbleUser,
      borderRadius: 16,
      borderBottomRightRadius: 4,
      paddingHorizontal: 12,
      paddingVertical: 8,
      marginTop: 8,
      marginHorizontal: 12,
      maxWidth: "82%",
    },
    bubbleAssistant: {
      alignSelf: "flex-start",
      backgroundColor: t.bubbleAgent,
      borderRadius: 16,
      borderBottomLeftRadius: 4,
      paddingHorizontal: 12,
      paddingVertical: 8,
      marginTop: 8,
      marginHorizontal: 12,
      maxWidth: "82%",
    },
    bubbleText: { fontSize: 15, color: t.text, lineHeight: 22 },
    systemPill: {
      alignSelf: "center",
      backgroundColor: t.chipBg,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 4,
      marginVertical: 8,
      maxWidth: "88%",
    },
    systemText: { fontSize: 12, color: t.textMuted, textAlign: "center" },
    toolChip: {
      flexDirection: "row",
      alignItems: "center",
      alignSelf: "flex-start",
      maxWidth: "100%",
      gap: 6,
      backgroundColor: t.chipBg,
      borderRadius: 8,
      paddingHorizontal: 8,
      paddingVertical: 5,
      marginTop: 4,
    },
    toolChipErr: { backgroundColor: t.dangerBg },
    // flexShrink lets a long, unbreakable tool name (e.g. an MCP tool id) ellipsize
    // instead of pushing the chip — and the time/chevron — past the bubble edge.
    toolChipText: { fontSize: 12, color: t.text, flexShrink: 1 },
    toolChipTime: { fontSize: 10, color: t.textMuted, marginLeft: 2 },
    // Per-message wall-clock time (WhatsApp-style), bottom-right of a bubble.
    msgTime: { fontSize: 11, color: t.textMuted, alignSelf: "flex-end", marginTop: 4 },
    // Row holding an optional pin glyph + the timestamp, bottom-right of a bubble.
    bubbleMetaRow: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 4 },
    // Pinned-message banner under the chat header.
    pinnedBanner: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
    pinnedBannerLabel: { fontSize: 11, fontWeight: "600" },
    pinnedBannerText: { fontSize: 13 },
    bubbleImage: { width: 220, height: 160, borderRadius: 8, marginTop: 6 },
    // Composer
    composerWrap: {
      backgroundColor: t.surface,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.border,
    },
    composerBar: {
      flexDirection: "row",
      alignItems: "flex-end",
      paddingHorizontal: 8,
      paddingTop: 8,
      paddingBottom: 8,
      gap: 8,
    },
    composerInput: {
      flex: 1,
      maxHeight: 120,
      minHeight: 40,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
      borderRadius: 22,
      paddingHorizontal: 14,
      paddingTop: Platform.OS === "ios" ? 10 : 8,
      paddingBottom: Platform.OS === "ios" ? 10 : 8,
      fontSize: 16,
      lineHeight: 20,
      color: t.text,
      backgroundColor: t.inputBg,
    },
    circleBtn: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: "center",
      justifyContent: "center",
    },
    sendBtn: { backgroundColor: t.accent },
    sendBtnDisabled: { backgroundColor: t.border },
    gearBtn: { backgroundColor: t.chipBg },
    runBar: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginHorizontal: 10,
      marginBottom: 6,
      paddingLeft: 12,
      paddingRight: 6,
      paddingVertical: 6,
      borderRadius: 18,
      backgroundColor: t.chipBg,
    },
    runText: { flex: 1, fontSize: 13, color: t.textMuted, fontWeight: "500" },
    // Floating "jump to latest" button, bottom-right above the composer.
    jumpBtn: {
      position: "absolute",
      right: 14,
      // Anchored to the LIST's bottom edge (its flex:1 wrapper), which always
      // sits just above the composer + run bar — so a small gap is all that's
      // needed, and it never collides with the variable-height controls below.
      bottom: 12,
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: t.accent,
      alignItems: "center",
      justifyContent: "center",
      shadowColor: "#000",
      shadowOpacity: 0.25,
      shadowRadius: 4,
      shadowOffset: { width: 0, height: 2 },
      elevation: 4,
    },
    // WhatsApp-style floating day header: centered, pinned near the top of the
    // thread, fades in only while scrolling.
    scrollDatePill: {
      position: "absolute",
      top: 8,
      alignSelf: "center",
      backgroundColor: t.chipBg,
      paddingHorizontal: 12,
      paddingVertical: 5,
      borderRadius: 12,
      shadowColor: "#000",
      shadowOpacity: 0.15,
      shadowRadius: 3,
      shadowOffset: { width: 0, height: 1 },
      elevation: 3,
      zIndex: 10,
    },
    scrollDateText: {
      fontSize: 12,
      fontWeight: "600",
      color: t.textMuted,
    },
    stopGhost: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 14,
      backgroundColor: t.surface,
      borderWidth: 1,
      borderColor: t.dangerBg,
    },
    stopGhostText: { color: t.danger, fontSize: 13, fontWeight: "700" },
    // Semantic border only — sage = queue (gentle, after), clay = interrupt now.
    // Label stays high-contrast so it's readable on both themes; the icon +
    // border carry the colour meaning.
    // Queue / Interrupt actions embedded in the working pill (between "Working…"
    // and Stop). Neutral, compact chips — the label says what each does; no
    // accent/danger colours (keeps the pill calm, not a traffic light).
    runModeToggle: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 13,
      borderWidth: 1,
      borderColor: t.border,
      backgroundColor: t.surface,
    },
    runModeText: { fontSize: 12, fontWeight: "600", color: t.textMuted },
    statusLine: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 14,
      paddingTop: 6,
    },
    statusText: { fontSize: 12, color: t.textMuted },
    // Composer settings bottom sheet (permission mode + model)
    sheet: {
      backgroundColor: t.surface,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
      paddingTop: 8,
      paddingBottom: 34,
    },
    sheetGrabber: {
      alignSelf: "center",
      width: 40,
      height: 4,
      borderRadius: 2,
      backgroundColor: t.border,
      marginBottom: 4,
    },
    sheetTitle: {
      fontSize: 17,
      fontWeight: "700",
      color: t.text,
      paddingHorizontal: 18,
      paddingTop: 6,
      paddingBottom: 2,
    },
    sheetSection: {
      fontSize: 11,
      fontWeight: "700",
      color: t.textMuted,
      letterSpacing: 1,
      paddingHorizontal: 18,
      marginTop: 16,
    },
    sheetHint: { fontSize: 12, color: t.textMuted, paddingHorizontal: 18, marginTop: 4, lineHeight: 17 },
    // Session settings: collapsible grouped cards. Each group is a rounded card
    // with a tappable header (icon + title + summary + chevron); the body reveals
    // on tap. Stable positions + icons build muscle memory; collapsing the long
    // tail (prompt/goal/loops/stats) kills the "one giant scroll" crowding.
    spCard: {
      marginHorizontal: 14,
      marginTop: 12,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: t.border,
      backgroundColor: t.surface,
      overflow: "hidden",
    },
    spCardHead: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: 14,
      paddingVertical: 14,
    },
    spCardIcon: {
      width: 30, height: 30, borderRadius: 8,
      alignItems: "center", justifyContent: "center",
      backgroundColor: t.chipBg,
    },
    spCardTitle: { fontSize: 15, fontWeight: "700", color: t.text },
    spCardSummary: { fontSize: 12, color: t.textMuted, marginTop: 1 },
    spCardBody: {
      paddingBottom: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.border,
    },
    // AI picker (ProviderPicker): iOS grouped-inset settings list — rounded
    // groups, hairline separators, title + muted subtitle, checkmark trailing.
    aiGroup: { marginHorizontal: 14, marginTop: 8, borderRadius: 12, backgroundColor: t.surface, overflow: "hidden" },
    aiRow: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 48, paddingHorizontal: 16, paddingVertical: 11, backgroundColor: t.surface },
    aiRowSep: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.border },
    aiRowTitle: { fontSize: 16, color: t.text },
    aiRowSub: { fontSize: 12, color: t.textMuted, marginTop: 2 },
    aiCheck: { fontSize: 17, fontWeight: "700", color: t.accent },
    aiSection: { fontSize: 13, fontWeight: "600", color: t.textMuted, paddingHorizontal: 30, marginTop: 22 },
    aiSectionHint: { fontSize: 12, color: t.textMuted, paddingHorizontal: 30, marginTop: 3, lineHeight: 16 },
    aiListRow: { marginHorizontal: 14 },
    aiSearch: { marginHorizontal: 14 },
    // iOS segmented control, inset exactly like aiGroup so its edges line up
    // with the grouped rows and section headings above and below it.
    aiSeg: { flexDirection: "row", marginHorizontal: 14, marginTop: 8, padding: 2, borderRadius: 9, backgroundColor: t.surface },
    aiSegItem: { flex: 1, minHeight: 32, alignItems: "center", justifyContent: "center", borderRadius: 7 },
    aiSegItemActive: { backgroundColor: t.accent },
    aiListFirst: { borderTopLeftRadius: 12, borderTopRightRadius: 12, marginTop: 8 },
    aiListLast: { borderBottomLeftRadius: 12, borderBottomRightRadius: 12 },
    // Capabilities screen (skills + MCP CRUD).
    capAddRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 18, paddingVertical: 14 },
    capAddText: { fontSize: 14, fontWeight: "600" },
    capRow: {
      flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 14,
      marginHorizontal: 12, marginTop: 8, borderRadius: 12, backgroundColor: t.surface,
    },
    capRowIcon: {
      width: 34, height: 34, borderRadius: 9, alignItems: "center" as const, justifyContent: "center" as const,
      backgroundColor: t.chipBg,
    },
    capRowName: { fontSize: 15, fontWeight: "600" },
    capRowDesc: { fontSize: 12, marginTop: 2, lineHeight: 16 },
    capBadge: { fontSize: 10, color: t.textMuted, borderColor: t.border, borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, overflow: "hidden" },
    capEmpty: { fontSize: 13, color: t.textMuted, padding: 18, textAlign: "center" as const },
    capTabCount: { fontSize: 12, fontWeight: "600", marginLeft: 4, opacity: 0.6 },
    capEditNameRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4 },
    capCodeInput: { minHeight: 280, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 12, textAlignVertical: "top", marginTop: 10 },
    capErr: { color: t.danger, fontSize: 12, marginTop: 8, marginHorizontal: 14 },
    capModalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
    capModalCard: { maxHeight: "88%", borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16 },
    capModalTitle: { fontSize: 17, fontWeight: "700", marginBottom: 10 },
    capModalActions: { flexDirection: "row", alignItems: "center", gap: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: t.border },
    // Real 44pt tap targets (HIG minimum) so the action row isn't a row of
    // pixel-thin glyphs; padding also visually separates Delete / Close / Save.
    capModalBtnHit: { minHeight: 44, paddingHorizontal: 14, justifyContent: "center" },
    capModalBtn: { fontSize: 16 },
    sheetPills: { paddingHorizontal: 18, paddingVertical: 10, gap: 8 },
    // Bordered + bg one step darker than the sheet so each pill reads as a
    // distinct, tappable element (previously chipBg on surface was near-invisible
    // in dark mode).
    sheetPill: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      paddingHorizontal: 15,
      paddingVertical: 9,
      borderRadius: 18,
      backgroundColor: t.bg,
      borderWidth: 1,
      borderColor: t.border,
    },
    sheetPillActive: { backgroundColor: t.accent, borderColor: t.accent },
    sheetPillText: { fontSize: 14, color: t.textMuted, fontWeight: "600" },
    sheetPillTextActive: { color: t.onAccent, fontWeight: "700" },
    // Secondary sheet action (Cancel): a muted, themed surface with a border —
    // reads as a soft pastel chip on both light and dark instead of a bright box.
    sheetCancel: {
      marginHorizontal: 18,
      marginTop: 10,
      paddingVertical: 13,
      borderRadius: 10,
      backgroundColor: t.chipBg,
      borderWidth: 1,
      borderColor: t.border,
      alignItems: "center",
    },
    sheetCancelText: { color: t.textMuted, fontSize: 15, fontWeight: "600" },
    // Session settings sheet (system prompt / goal / loops / filter / notify)
    ssInput: {
      marginHorizontal: 18,
      marginTop: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: t.border,
      backgroundColor: t.inputBg,
      color: t.text,
      fontSize: 14,
    },
    ssMultiline: { minHeight: 76, textAlignVertical: "top" },
    ssRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginHorizontal: 18,
      marginTop: 12,
      paddingVertical: 6,
    },
    ssRowLabel: { fontSize: 15, color: t.text, fontWeight: "600" },
    ssRowHint: { fontSize: 12, color: t.textMuted, marginTop: 2, maxWidth: 230 },
    // Filter chips (You / Assistant / Tools / System) — grid of toggles
    // Job list rows (scheduled jobs)
    ssJobRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      marginHorizontal: 18,
      marginTop: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: t.border,
      backgroundColor: t.bg,
    },
    ssJobPrompt: { fontSize: 13, color: t.text, lineHeight: 18 },
    ssJobSchedule: { fontSize: 11, color: t.accent, fontWeight: "700" },
    ssJobNext: { fontSize: 11, color: t.textMuted },
  })
}

// The two halves are spread into one object, so a name defined in both would
// silently let the second win. This fails to compile if they ever overlap.
type Overlap = keyof ReturnType<typeof buildCoreStyles> & keyof ReturnType<typeof buildScreenStyles>
const _noOverlap: [Overlap] extends [never] ? true : Overlap = true
void _noOverlap

function buildStyles(t: Theme) {
  return { ...buildCoreStyles(t), ...buildScreenStyles(t) }
}

export type AppStyles = ReturnType<typeof buildStyles>

// Memo cache: LIGHT/DARK are stable singletons, so buildStyles runs at most twice.
const _cache = new Map<Theme, AppStyles>()

export function makeStyles(t: Theme): AppStyles {
  let s = _cache.get(t)
  if (!s) {
    s = buildStyles(t)
    _cache.set(t, s)
  }
  return s
}

/** Hook: the stylesheet for the active theme. Repaints on theme change. */
export function useStyles(): AppStyles {
  return makeStyles(useTheme())
}
