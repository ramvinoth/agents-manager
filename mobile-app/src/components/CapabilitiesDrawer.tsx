/**
 * CapabilitiesDrawer — a right-side slide-in panel showing Skills and MCP tools
 * for the current session. Mirrors the web's RhsPanel / MobileNav Sheet pattern.
 *
 * Opens from the tools icon in the ThreadScreen header (rightmost icon).
 * Dismisses on backdrop tap, swipe-right, or toggling the icon again.
 */
import React, { useCallback, useEffect, useRef, useState } from "react"
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { api, type Capabilities, type McpServer, type Skill } from "../api/client"
import { useTheme } from "../lib/useTheme"
import { useStyles } from "../screens/styles"
import { SkillEditor, McpEditor } from "./CapabilitiesEditors"
import Icon from "./Icon"

const SCREEN_W = Dimensions.get("window").width
const DRAWER_W = Math.min(SCREEN_W * 0.85, 360)

interface Props {
  visible: boolean
  host: string
  cwd?: string
  onClose: () => void
}

export default function CapabilitiesDrawer({ visible, host, cwd, onClose }: Props) {
  const t = useTheme()
  const styles = useStyles()
  const insets = useSafeAreaInsets()

  const slideAnim = useRef(new Animated.Value(DRAWER_W)).current
  const backdropAnim = useRef(new Animated.Value(0)).current
  const [rendered, setRendered] = useState(false)

  const [tab, setTab] = useState<"skills" | "mcp">("skills")
  const [caps, setCaps] = useState<Capabilities | null>(null)
  const [loading, setLoading] = useState(false)
  const [skillEdit, setSkillEdit] = useState<Skill | null | undefined>(undefined)
  const [mcpEdit, setMcpEdit] = useState<McpServer | null | undefined>(undefined)

  const load = useCallback(() => {
    setLoading(true)
    api
      .capabilities(host, cwd)
      .then(setCaps)
      .catch(() => setCaps({ skills: [], mcp: [] }))
      .finally(() => setLoading(false))
  }, [host, cwd])

  // Animate open/close
  useEffect(() => {
    if (visible) {
      setRendered(true)
      load()
      Animated.parallel([
        Animated.spring(slideAnim, { toValue: 0, useNativeDriver: true, tension: 65, friction: 11 }),
        Animated.timing(backdropAnim, { toValue: 1, duration: 200, useNativeDriver: true }),
      ]).start()
    } else {
      Animated.parallel([
        Animated.timing(slideAnim, { toValue: DRAWER_W, duration: 200, useNativeDriver: true }),
        Animated.timing(backdropAnim, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start(() => setRendered(false))
    }
  }, [visible])

  // Swipe-right to dismiss
  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => g.dx > 15 && Math.abs(g.dy) < 30,
      onPanResponderMove: (_, g) => {
        if (g.dx > 0) slideAnim.setValue(g.dx)
      },
      onPanResponderRelease: (_, g) => {
        if (g.dx > DRAWER_W * 0.3 || g.vx > 0.5) {
          onClose()
        } else {
          Animated.spring(slideAnim, { toValue: 0, useNativeDriver: true }).start()
        }
      },
    })
  ).current

  if (!rendered) return null

  const skillCount = caps?.skills.length ?? 0
  const mcpCount = caps?.mcp.length ?? 0

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {/* Backdrop */}
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose}>
        <Animated.View
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: "rgba(0,0,0,0.4)", opacity: backdropAnim },
          ]}
        />
      </Pressable>

      {/* Drawer */}
      <Animated.View
        {...panResponder.panHandlers}
        style={[
          localStyles.drawer,
          {
            width: DRAWER_W,
            backgroundColor: t.bg,
            paddingTop: insets.top,
            paddingBottom: insets.bottom,
            transform: [{ translateX: slideAnim }],
          },
        ]}
      >
        {/* Header — flush to top; safe-area padding is on the drawer itself */}
        <View style={{ alignItems: "center", paddingTop: 8, paddingBottom: 4 }}>
          <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: t.textMuted + "40" }} />
        </View>
        <View style={localStyles.header}>
          <Text style={[localStyles.headerTitle, { color: t.text }]}>Skills & tools</Text>
          <TouchableOpacity onPress={onClose} hitSlop={8}>
            <Icon name="close" size={20} color={t.textMuted} />
          </TouchableOpacity>
        </View>

        {/* Tab switch with counts */}
        <View style={styles.segRow}>
          {([["skills", "Skills", skillCount], ["mcp", "MCP tools", mcpCount]] as const).map(([v, label, count]) => {
            const active = tab === v
            return (
              <TouchableOpacity
                key={v}
                testID={`drawer-tab-${v}`}
                style={[styles.seg, active ? styles.segActive : null]}
                onPress={() => setTab(v as "skills" | "mcp")}
              >
                <Text style={[styles.segText, active ? styles.segTextActive : null]}>
                  {label}
                </Text>
                {!loading && count > 0 ? (
                  <Text style={[styles.segText, active ? styles.segTextActive : null, styles.capTabCount]}>
                    {count}
                  </Text>
                ) : null}
              </TouchableOpacity>
            )
          })}
        </View>

        {/* Content */}
        {loading ? (
          <ActivityIndicator size="small" color={t.textMuted} style={{ marginTop: 24 }} />
        ) : (
          <ScrollView
            contentContainerStyle={{ paddingBottom: 40, paddingTop: 4 }}
            keyboardShouldPersistTaps="handled"
          >
            {tab === "skills" ? (
              <>
                <TouchableOpacity testID="drawer-add-skill" style={styles.capAddRow} onPress={() => setSkillEdit(null)}>
                  <Icon name="add" size={16} color={t.accent} />
                  <Text style={[styles.capAddText, { color: t.accent }]}>New skill</Text>
                </TouchableOpacity>
                {skillCount ? (
                  caps!.skills.map((s) => (
                    <TouchableOpacity key={s.path} style={styles.capRow} onPress={() => setSkillEdit(s)}>
                      <View style={[styles.capRowIcon, { backgroundColor: t.accent + "18" }]}>
                        <Icon name="sparkle" size={16} color={t.accent} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.capRowName, { color: t.text }]} numberOfLines={1}>
                          /{s.name}
                        </Text>
                        {s.description ? (
                          <Text style={[styles.capRowDesc, { color: t.textMuted }]} numberOfLines={2}>
                            {s.description}
                          </Text>
                        ) : null}
                      </View>
                      <Text style={[styles.capBadge, { color: t.textMuted, borderColor: t.border }]}>{s.source}</Text>
                    </TouchableOpacity>
                  ))
                ) : (
                  <Text style={styles.capEmpty}>No skills found.</Text>
                )}
              </>
            ) : (
              <>
                <TouchableOpacity testID="drawer-add-mcp" style={styles.capAddRow} onPress={() => setMcpEdit(null)}>
                  <Icon name="add" size={16} color={t.accent} />
                  <Text style={[styles.capAddText, { color: t.accent }]}>Add MCP server</Text>
                </TouchableOpacity>
                {mcpCount ? (
                  caps!.mcp.map((m) => (
                    <TouchableOpacity key={`${m.scope}:${m.name}`} style={styles.capRow} onPress={() => setMcpEdit(m)}>
                      <View style={[styles.capRowIcon, { backgroundColor: t.textMuted + "18" }]}>
                        <Icon name="tool" size={16} color={t.textMuted} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.capRowName, { color: t.text }]} numberOfLines={1}>
                          {m.name}
                        </Text>
                        <Text style={[styles.capRowDesc, { color: t.textMuted }]} numberOfLines={1}>
                          {m.transport}
                          {m.target ? ` · ${m.target}` : ""}
                        </Text>
                      </View>
                      <Text style={[styles.capBadge, { color: t.textMuted, borderColor: t.border }]}>{m.scope}</Text>
                    </TouchableOpacity>
                  ))
                ) : (
                  <Text style={styles.capEmpty}>No MCP servers configured.</Text>
                )}
              </>
            )}
          </ScrollView>
        )}

        {skillEdit !== undefined && (
          <SkillEditor skill={skillEdit} host={host} cwd={cwd} onClose={() => setSkillEdit(undefined)} onSaved={load} />
        )}
        {mcpEdit !== undefined && (
          <McpEditor server={mcpEdit} host={host} cwd={cwd} onClose={() => setMcpEdit(undefined)} onSaved={load} />
        )}
      </Animated.View>
    </View>
  )
}

const localStyles = StyleSheet.create({
  drawer: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    shadowColor: "#000",
    shadowOffset: { width: -2, height: 0 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 16,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 10,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: "700",
  },
})
