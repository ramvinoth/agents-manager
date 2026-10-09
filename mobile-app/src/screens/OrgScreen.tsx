import React, { useCallback, useEffect, useState } from "react"
import { ActivityIndicator, ScrollView, Text, TouchableOpacity, View } from "react-native"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api, type LearnedSkill, type OrgProject } from "../api/client"
import { setToken } from "../state/config"
import Icon from "../components/Icon"
import CreateSheet from "../components/CreateSheet"
import { useTheme } from "../lib/useTheme"

type Props = NativeStackScreenProps<RootStackParamList, "Org">

/**
 * OrgScreen — the org dashboard: projects (each opens its board and code map),
 * the read-only activity log, and the skills the team has learned. Org approvals
 * are decided in the decision queue (board band → cockpit, Inbox), not here, and
 * the automation master switch lives in Profile. Agent authority is set per
 * chat (Trust) or per agent template — there is no separate employee roster.
 */
export default function OrgScreen({ navigation }: Props) {
  const t = useTheme()
  const [projects, setProjects] = useState<OrgProject[]>([])
  const [skills, setSkills] = useState<LearnedSkill[]>([])
  // The library route returns every skill on disk; this section is about what the
  // TEAM learned, so it shows only rows with ledger provenance (an id).
  const learned = skills.filter((s) => s.id != null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  const load = useCallback(async () => {
    setError("")
    try {
      const [p, sk] = await Promise.all([
        api.orgProjects(),
        api.orgSkills().catch(() => ({ skills: [] as LearnedSkill[] })),
      ])
      setProjects(p.projects || [])
      setSkills(sk.skills || [])
    } catch (err) {
      const ex = err as Error & { status?: number }
      if (ex.status === 401) { setToken(null); navigation.replace("Login"); return }
      setError(ex.message)
    } finally {
      setLoading(false)
    }
  }, [navigation])

  useEffect(() => {
    load()
    const id = setInterval(load, 5000)
    return () => clearInterval(id)
  }, [load])

  // Create a project via a cross-platform sheet (Alert.prompt is iOS-only, so an
  // inline prompt silently no-ops on Android). A project needs a real workspace
  // dir — without a cwd a Harman-spawned session falls back to $HOME, which is
  // wrong — so we offer recent dirs as suggestions.
  const [creating, setCreating] = useState(false)
  const [dirs, setDirs] = useState<string[]>([])

  function openCreate() {
    setCreating(true)
    if (!dirs.length) {
      api.projects("local").then((ps) => setDirs(ps.map((p) => p.cwd))).catch(() => {})
    }
  }

  async function submitCreate(values: Record<string, string>) {
    try {
      await api.orgCreateProject({ name: values.name, cwd: values.cwd || "", description: values.description || "" })
      load()
    } catch (e) { setError((e as Error).message) }
  }

  if (loading) {
    return <View style={{ flex: 1, backgroundColor: t.bg, alignItems: "center", justifyContent: "center" }}><ActivityIndicator /></View>
  }

  const Section = ({ title, onAdd, children }: { title: string; onAdd?: () => void; children: React.ReactNode }) => (
    <View style={{ marginBottom: 18 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <Text style={{ color: t.textMuted, fontSize: 12, fontWeight: "700", letterSpacing: 0.5 }}>{title.toUpperCase()}</Text>
        {onAdd ? (
          <TouchableOpacity testID={`org-add-${title.toLowerCase()}`} onPress={onAdd} hitSlop={8}>
            <Icon name="add" size={18} color={t.accent} />
          </TouchableOpacity>
        ) : null}
      </View>
      {children}
    </View>
  )

  const Row = ({ children }: { children: React.ReactNode }) => (
    <View style={{ backgroundColor: t.surface, borderRadius: 10, borderWidth: 1, borderColor: t.border, padding: 12, marginBottom: 6 }}>{children}</View>
  )

  return (
    <>
    <ScrollView style={{ flex: 1, backgroundColor: t.bg }} contentContainerStyle={{ padding: 16 }}>
      {error ? <Text style={{ color: t.danger, marginBottom: 12 }}>{error}</Text> : null}

      {/* First-run guide: shown until the CEO has at least one project. A fresh
          install otherwise looks like empty lists with no hint of the workflow. */}
      {projects.length === 0 ? (
        <View style={{ backgroundColor: t.surface, borderRadius: 12, borderWidth: 1, borderColor: t.border, padding: 14, marginBottom: 18 }}>
          <Text style={{ color: t.text, fontWeight: "700", fontSize: 15, marginBottom: 8 }}>Set up your first run</Text>
          {[
            "Create a project — give it a name and the workspace directory the board should work in.",
            "Open the project board and add a card or two describing the work.",
            "Start a chat in the project's directory and ask it to work the board.",
          ].map((step, i) => (
            <View key={i} style={{ flexDirection: "row", gap: 8, marginBottom: 6 }}>
              <Text style={{ color: t.accent, fontWeight: "700", fontSize: 13 }}>{i + 1}.</Text>
              <Text style={{ color: t.textMuted, fontSize: 13, flex: 1, lineHeight: 18 }}>{step}</Text>
            </View>
          ))}
        </View>
      ) : null}

      <Section title="Projects" onAdd={openCreate}>
        {projects.length ? projects.map((p) => (
          <TouchableOpacity key={p.id} onPress={() => navigation.navigate("Kanban", { project: p.id, title: p.name })}>
            <Row>
              <Text style={{ color: t.text, fontWeight: "600" }}>{p.name}</Text>
              {p.description ? <Text style={{ color: t.textMuted, fontSize: 12, marginTop: 2 }} numberOfLines={1}>{p.description}</Text> : null}
              {p.host === "local" || !p.host ? (
                <TouchableOpacity
                  testID={`org-project-map-${p.id}`}
                  accessibilityRole="button"
                  accessibilityLabel={`Code map of ${p.name}`}
                  onPress={() => navigation.navigate("Map", { project: p.id, title: p.name })}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  style={{ alignSelf: "flex-start", marginTop: 6 }}
                >
                  <Text style={{ color: t.accent, fontSize: 13, fontWeight: "600" }}>Code map</Text>
                </TouchableOpacity>
              ) : null}
            </Row>
          </TouchableOpacity>
        )) : <Text style={{ color: t.textMuted, fontStyle: "italic" }}>No projects yet.</Text>}
      </Section>

      <TouchableOpacity
        testID="org-audit"
        accessibilityRole="button"
        accessibilityLabel="Activity, who did what and when"
        onPress={() => navigation.navigate("Audit")}
        style={{ minHeight: 44, paddingVertical: 14, borderTopWidth: 1, borderBottomWidth: 1, borderColor: t.border, marginBottom: 18, flexDirection: "row", alignItems: "center", gap: 12 }}
      >
        <View style={{ flex: 1 }}>
          <Text style={{ color: t.text, fontSize: 17, fontWeight: "600" }}>Activity</Text>
          <Text style={{ color: t.textMuted, fontSize: 14, marginTop: 4 }}>Who did what, and when</Text>
        </View>
        <Icon name="chevronRight" size={18} color={t.textMuted} />
      </TouchableOpacity>

      <Section title="Skills learned">
        {learned.length ? learned.map((s) => (
          <View key={s.name} style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 }}>
            <Icon name={s.status === "active" ? "sparkle" : "clock"} size={14} color={s.status === "active" ? t.accent : t.textMuted} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: t.text, fontSize: 13 }} numberOfLines={1}>{s.name}</Text>
              {s.description ? <Text style={{ color: t.textMuted, fontSize: 11 }} numberOfLines={2}>{s.description}</Text> : null}
            </View>
            <Text style={{ color: t.textMuted, fontSize: 11 }}>{s.status}</Text>
          </View>
        )) : <Text style={{ color: t.textMuted, fontStyle: "italic" }}>Nothing learned yet.</Text>}
      </Section>

    </ScrollView>

      <CreateSheet
        visible={creating}
        title="New project"
        fields={[
          { key: "name", label: "Name", placeholder: "e.g. Onboarding revamp", required: true },
          { key: "cwd", label: "Workspace directory", placeholder: "/path/to/repo", required: true, autoCapitalize: "none", suggestions: dirs },
          { key: "description", label: "Description", placeholder: "What is this project?" },
        ]}
        onSubmit={submitCreate}
        onClose={() => setCreating(false)}
      />
    </>
  )
}
