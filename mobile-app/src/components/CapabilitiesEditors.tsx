/**
 * Shared editor components for Skills and MCP tools — used by both
 * CapabilitiesScreen (full-screen) and CapabilitiesDrawer (slide-in).
 *
 * Extracted to avoid duplicating editor logic in two places.
 */
import React, { useEffect, useState } from "react"
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { api, type McpServer, type Skill } from "../api/client"
import { useTheme } from "../lib/useTheme"
import { useStyles } from "../screens/styles"

const NEW_SKILL =
  "---\ndescription: What this skill does and when to use it\n---\n\n# New Skill\n\nInstructions for Claude when this skill is invoked.\n"
const NEW_MCP = JSON.stringify({ command: "npx", args: ["-y", "some-mcp-server"], env: {} }, null, 2)

export function EditorModal({
  title,
  children,
  onClose,
  onSave,
  onDelete,
  deleteLabel,
}: {
  title: string
  children: React.ReactNode
  onClose: () => void
  onSave?: () => void
  onDelete?: () => void
  deleteLabel?: string
}) {
  const styles = useStyles()
  const t = useTheme()
  const insets = useSafeAreaInsets()
  // Every other destructive action in the app confirms first (ChatActions,
  // ProvidersScreen, KanbanScreen…). Route delete through the same Alert so a
  // single mis-tap can't erase a skill/MCP server with no undo.
  const confirmDelete = onDelete
    ? () =>
        Alert.alert(deleteLabel ? `Delete ${deleteLabel}?` : "Delete?", "This can't be undone.", [
          { text: "Cancel", style: "cancel" },
          { text: "Delete", style: "destructive", onPress: onDelete },
        ])
    : undefined
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.capModalBackdrop}
      >
        <View style={[styles.capModalCard, { backgroundColor: t.bg }]}>
          <Text style={[styles.capModalTitle, { color: t.text }]}>{title}</Text>
          <ScrollView keyboardShouldPersistTaps="handled">{children}</ScrollView>
          <View style={[styles.capModalActions, { paddingBottom: Math.max(insets.bottom, 8) }]}>
            {confirmDelete ? (
              <TouchableOpacity testID="cap-delete" onPress={confirmDelete} style={styles.capModalBtnHit}>
                <Text style={[styles.capModalBtn, { color: t.danger }]}>Delete</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity testID="cap-close" onPress={onClose} style={[styles.capModalBtnHit, { marginLeft: "auto" }]}>
              <Text style={[styles.capModalBtn, { color: t.textMuted }]}>Close</Text>
            </TouchableOpacity>
            {onSave ? (
              <TouchableOpacity testID="cap-save" onPress={onSave} style={styles.capModalBtnHit}>
                <Text style={[styles.capModalBtn, { color: t.accent, fontWeight: "700" }]}>Save</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}

export function ScopePicker({ value, opts, onPick }: { value: string; opts: string[]; onPick: (v: string) => void }) {
  const styles = useStyles()
  return (
    <View style={{ flexDirection: "row", gap: 6 }}>
      {opts.map((o) => {
        const active = value === o
        return (
          <TouchableOpacity
            key={o}
            testID={`cap-scope-${o}`}
            style={[styles.sheetPill, active ? styles.sheetPillActive : null]}
            onPress={() => onPick(o)}
          >
            <Text style={[styles.sheetPillText, active ? styles.sheetPillTextActive : null]}>{o}</Text>
          </TouchableOpacity>
        )
      })}
    </View>
  )
}

export function SkillEditor({
  skill,
  host,
  cwd,
  onClose,
  onSaved,
}: {
  skill: Skill | null
  host: string
  cwd?: string
  onClose: () => void
  onSaved: () => void
}) {
  const styles = useStyles()
  const t = useTheme()
  const [name, setName] = useState(skill?.name ?? "")
  const [scope, setScope] = useState<"user" | "project">("user")
  const [content, setContent] = useState<string | null>(skill ? null : NEW_SKILL)
  const [err, setErr] = useState("")
  const readonly = !!skill && !skill.editable

  // Fetch skill content when editing an existing skill.
  useEffect(() => {
    if (skill && skill.path) {
      setContent(null)
      api
        .skill(host, skill.path)
        .then((d) => setContent(d.error ? "" : d.content || ""))
        .catch(() => setContent(""))
    }
  }, [skill?.path, host])

  async function save() {
    setErr("")
    try {
      const d = await api.skillSave({ name, scope, content: content ?? "", cwd, host })
      if (d.error) throw new Error(d.error)
      onSaved()
      onClose()
    } catch (e) {
      setErr((e as Error).message)
    }
  }
  async function del() {
    if (!skill) return
    await api.skillDelete({ path: skill.path, host }).catch(() => {})
    onSaved()
    onClose()
  }

  return (
    <EditorModal
      title={skill ? (readonly ? "View skill" : "Edit skill") : "New skill"}
      onClose={onClose}
      onSave={readonly ? undefined : save}
      onDelete={skill?.editable ? del : undefined}
      deleteLabel={skill ? `/${skill.name}` : undefined}
    >
      <Text style={{ fontSize: 12, fontWeight: "600", color: t.textMuted, marginBottom: 4 }}>
        {skill ? "NAME" : "SKILL NAME"}
      </Text>
      <View style={styles.capEditNameRow}>
        <TextInput
          testID="cap-skill-name"
          style={[styles.ssInput, { flex: 1 }]}
          value={name}
          onChangeText={setName}
          editable={!skill}
          placeholder="my-skill"
          placeholderTextColor={t.textMuted}
          autoCapitalize="none"
        />
        {skill ? (
          <Text style={[styles.capBadge, { color: t.textMuted, borderColor: t.border }]}>{skill.source}</Text>
        ) : (
          <ScopePicker value={scope} opts={["user", "project"]} onPick={(v) => setScope(v as "user" | "project")} />
        )}
      </View>
      <Text style={{ fontSize: 12, fontWeight: "600", color: t.textMuted, marginTop: 12, marginBottom: 4 }}>
        CONTENT
      </Text>
      <TextInput
        testID="cap-skill-body"
        style={[styles.ssInput, styles.capCodeInput]}
        value={content ?? ""}
        onChangeText={setContent}
        editable={!readonly}
        placeholder={content === null ? "Loading\u2026" : ""}
        placeholderTextColor={t.textMuted}
        multiline
      />
      {err ? <Text style={styles.capErr}>{err}</Text> : null}
    </EditorModal>
  )
}

export function McpEditor({
  server,
  host,
  cwd,
  onClose,
  onSaved,
}: {
  server: McpServer | null
  host: string
  cwd?: string
  onClose: () => void
  onSaved: () => void
}) {
  const styles = useStyles()
  const t = useTheme()
  const [name, setName] = useState(server?.name ?? "")
  const [scope, setScope] = useState<string>(server ? (server.scope === "global" ? "global" : "project") : "project")
  const [cfg, setCfg] = useState(server ? JSON.stringify(server.config, null, 2) : NEW_MCP)
  const [err, setErr] = useState("")
  const readonly = !!server && !server.editable

  async function save() {
    setErr("")
    if (!name) return setErr("Server name required")
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(cfg)
    } catch (e) {
      return setErr("Invalid JSON: " + (e as Error).message)
    }
    try {
      const d = await api.mcpSave({ name, scope, config: parsed, cwd, host })
      if (d.error) throw new Error(d.error)
      onSaved()
      onClose()
    } catch (e) {
      setErr((e as Error).message)
    }
  }
  async function del() {
    if (!server) return
    await api
      .mcpDelete({ name: server.name, scope: server.scope === "global" ? "global" : "project", cwd, host })
      .catch(() => {})
    onSaved()
    onClose()
  }

  return (
    <EditorModal
      title={server ? (readonly ? "View MCP server" : "Edit MCP server") : "Add MCP server"}
      onClose={onClose}
      onSave={readonly ? undefined : save}
      onDelete={server?.editable ? del : undefined}
      deleteLabel={server?.name}
    >
      <Text style={{ fontSize: 12, fontWeight: "600", color: t.textMuted, marginBottom: 4 }}>
        {server ? "SERVER NAME" : "NAME"}
      </Text>
      <View style={styles.capEditNameRow}>
        <TextInput
          testID="cap-mcp-name"
          style={[styles.ssInput, { flex: 1 }]}
          value={name}
          onChangeText={setName}
          editable={!server}
          placeholder="server-name"
          placeholderTextColor={t.textMuted}
          autoCapitalize="none"
        />
        {server ? (
          <Text style={[styles.capBadge, { color: t.textMuted, borderColor: t.border }]}>{server.scope}</Text>
        ) : (
          <ScopePicker value={scope} opts={["project", "global"]} onPick={setScope} />
        )}
      </View>
      <Text style={{ fontSize: 12, fontWeight: "600", color: t.textMuted, marginTop: 12, marginBottom: 4 }}>
        CONFIGURATION (JSON)
      </Text>
      <TextInput
        testID="cap-mcp-config"
        style={[styles.ssInput, styles.capCodeInput]}
        value={cfg}
        onChangeText={setCfg}
        editable={!readonly}
        autoCapitalize="none"
        multiline
      />
      {err ? <Text style={styles.capErr}>{err}</Text> : null}
    </EditorModal>
  )
}
