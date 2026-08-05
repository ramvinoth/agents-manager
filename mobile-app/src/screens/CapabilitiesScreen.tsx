import React, { useCallback, useState } from "react"
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native"
import { useFocusEffect } from "@react-navigation/native"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api, type Capabilities, type McpServer, type Skill } from "../api/client"
import { activeProject, currentHost } from "../state/config"
import { useTheme } from "../lib/useTheme"
import Icon from "../components/Icon"
import { useStyles } from "./styles"

type Props = NativeStackScreenProps<RootStackParamList, "Capabilities">

const NEW_SKILL =
  "---\ndescription: What this skill does and when to use it\n---\n\n# New Skill\n\nInstructions for Claude when this skill is invoked.\n"
const NEW_MCP = JSON.stringify({ command: "npx", args: ["-y", "some-mcp-server"], env: {} }, null, 2)

/**
 * Skills + MCP tools manager — the mobile counterpart of the web RhsPanel
 * Capabilities tab. Lists both from /api/capabilities (host- and project-aware)
 * and offers add / edit / delete for each, mirroring the server CRUD the web UI
 * already uses (skill save/delete, mcp save/delete).
 */
export default function CapabilitiesScreen(_props: Props) {
  const styles = useStyles()
  const t = useTheme()
  const host = currentHost()
  const cwd = activeProject() || undefined

  const [tab, setTab] = useState<"skills" | "mcp">("skills")
  const [caps, setCaps] = useState<Capabilities | null>(null)
  const [loading, setLoading] = useState(true)
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

  useFocusEffect(useCallback(() => load(), [load]))

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      {/* Skills / MCP tab switch. */}
      <View style={styles.segRow}>
        {(["skills", "mcp"] as const).map((v) => {
          const active = tab === v
          return (
            <TouchableOpacity
              key={v}
              testID={`cap-tab-${v}`}
              style={[styles.seg, active ? styles.segActive : null]}
              onPress={() => setTab(v)}
            >
              <Text style={[styles.segText, active ? styles.segTextActive : null]}>
                {v === "skills" ? "Skills" : "MCP tools"}
              </Text>
            </TouchableOpacity>
          )
        })}
      </View>

      {loading ? (
        <ActivityIndicator size="small" color={t.textMuted} style={{ marginTop: 24 }} />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: 40 }}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
        >
          {tab === "skills" ? (
            <>
              <TouchableOpacity testID="cap-add-skill" style={styles.capAddRow} onPress={() => setSkillEdit(null)}>
                <Icon name="add" size={16} color={t.accent} />
                <Text style={[styles.capAddText, { color: t.accent }]}>New skill</Text>
              </TouchableOpacity>
              {caps?.skills.length ? (
                caps.skills.map((s) => (
                  <TouchableOpacity key={s.path} testID={`cap-skill-${s.name}`} style={styles.capRow} onPress={() => setSkillEdit(s)}>
                    <Icon name="sparkle" size={16} color={t.textMuted} />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.capRowName, { color: t.text }]} numberOfLines={1}>
                        {s.name}
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
              <TouchableOpacity testID="cap-add-mcp" style={styles.capAddRow} onPress={() => setMcpEdit(null)}>
                <Icon name="add" size={16} color={t.accent} />
                <Text style={[styles.capAddText, { color: t.accent }]}>Add MCP server</Text>
              </TouchableOpacity>
              {caps?.mcp.length ? (
                caps.mcp.map((m) => (
                  <TouchableOpacity key={`${m.scope}:${m.name}`} testID={`cap-mcp-${m.name}`} style={styles.capRow} onPress={() => setMcpEdit(m)}>
                    <Icon name="tool" size={16} color={t.textMuted} />
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
    </View>
  )
}

function SkillEditor({
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

  // Lazy-load an existing skill's markdown body on first open.
  if (skill && content === null) {
    api
      .skill(host, skill.path)
      .then((d) => setContent(d.error ? "" : d.content || ""))
      .catch(() => setContent(""))
  }

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
    >
      <View style={styles.capEditNameRow}>
        <TextInput
          testID="cap-skill-name"
          style={[styles.ssInput, { flex: 1 }]}
          value={name}
          onChangeText={setName}
          editable={!skill}
          placeholder="skill-name"
          placeholderTextColor={t.textMuted}
          autoCapitalize="none"
        />
        {skill ? (
          <Text style={[styles.capBadge, { color: t.textMuted, borderColor: t.border }]}>{skill.source}</Text>
        ) : (
          <ScopePicker value={scope} opts={["user", "project"]} onPick={(v) => setScope(v as "user" | "project")} />
        )}
      </View>
      <TextInput
        testID="cap-skill-body"
        style={[styles.ssInput, styles.capCodeInput]}
        value={content ?? ""}
        onChangeText={setContent}
        editable={!readonly}
        placeholder={content === null ? "Loading…" : ""}
        placeholderTextColor={t.textMuted}
        multiline
      />
      {err ? <Text style={styles.capErr}>{err}</Text> : null}
    </EditorModal>
  )
}

function McpEditor({
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
    >
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

function ScopePicker({ value, opts, onPick }: { value: string; opts: string[]; onPick: (v: string) => void }) {
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

function EditorModal({
  title,
  children,
  onClose,
  onSave,
  onDelete,
}: {
  title: string
  children: React.ReactNode
  onClose: () => void
  onSave?: () => void
  onDelete?: () => void
}) {
  const styles = useStyles()
  const t = useTheme()
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.capModalBackdrop}>
        <View style={[styles.capModalCard, { backgroundColor: t.bg }]}>
          <Text style={[styles.capModalTitle, { color: t.text }]}>{title}</Text>
          <ScrollView keyboardShouldPersistTaps="handled">{children}</ScrollView>
          <View style={styles.capModalActions}>
            {onDelete ? (
              <TouchableOpacity testID="cap-delete" onPress={onDelete} style={{ marginRight: "auto" }}>
                <Text style={[styles.capModalBtn, { color: t.danger }]}>Delete</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity testID="cap-close" onPress={onClose}>
              <Text style={[styles.capModalBtn, { color: t.textMuted }]}>Close</Text>
            </TouchableOpacity>
            {onSave ? (
              <TouchableOpacity testID="cap-save" onPress={onSave}>
                <Text style={[styles.capModalBtn, { color: t.accent, fontWeight: "700" }]}>Save</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </View>
      </View>
    </Modal>
  )
}
