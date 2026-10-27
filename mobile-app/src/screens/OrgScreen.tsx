import React, { useCallback, useEffect, useState } from "react"
import { ActivityIndicator, RefreshControl, ScrollView, Text, TouchableOpacity, View } from "react-native"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api, type LearnedSkill, type OrgProject } from "../api/client"
import { setToken } from "../state/config"
import Icon from "../components/Icon"
import CreateSheet from "../components/CreateSheet"
import { useTheme } from "../lib/useTheme"
import { useStyles } from "../lib/styles"
import { userError } from "../lib/errors"

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
  const styles = useStyles()
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
  // dir — without a cwd a Manager-spawned session falls back to $HOME, which is
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
    } catch (e) { setError(userError(e, "the project", "create")) }
  }

  if (loading) {
    return <View style={styles.center}><ActivityIndicator /></View>
  }

  const Section = ({ title, onAdd, children }: { title: string; onAdd?: () => void; children: React.ReactNode }) => (
    <View style={styles.orgSection}>
      <View style={styles.orgSectionHead}>
        <Text style={styles.orgSectionTitle}>{title.toUpperCase()}</Text>
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
    <View style={styles.orgRow}>{children}</View>
  )

  return (
    <>
    <ScrollView style={styles.page} contentContainerStyle={styles.orgContent}
      refreshControl={<RefreshControl refreshing={false} onRefresh={load} />}>
      {error ? <Text style={styles.orgError}>{error}</Text> : null}

      {/* First-run guide: shown until the CEO has at least one project. A fresh
          install otherwise looks like empty lists with no hint of the workflow. */}
      {projects.length === 0 ? (
        <View style={styles.orgSetup}>
          <Text style={styles.orgSetupTitle}>Set up your first run</Text>
          {[
            "Create a project — give it a name and the workspace directory the board should work in.",
            "Open the project board and add a card or two describing the work.",
            "Start a chat in the project's directory and ask it to work the board.",
          ].map((step, i) => (
            <View key={i} style={styles.orgStep}>
              <Text style={styles.orgStepNum}>{i + 1}.</Text>
              <Text style={styles.orgStepText}>{step}</Text>
            </View>
          ))}
        </View>
      ) : null}

      <Section title="Projects" onAdd={openCreate}>
        {projects.length ? projects.map((p) => (
          <TouchableOpacity key={p.id} onPress={() => navigation.navigate("Kanban", { project: p.id, title: p.name })}>
            <Row>
              <Text style={styles.orgName}>{p.name}</Text>
              {p.description ? <Text style={styles.orgDesc} numberOfLines={1}>{p.description}</Text> : null}
              {p.host === "local" || !p.host ? (
                <TouchableOpacity
                  testID={`org-project-map-${p.id}`}
                  accessibilityRole="button"
                  accessibilityLabel={`Code map of ${p.name}`}
                  onPress={() => navigation.navigate("Map", { project: p.id, title: p.name })}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  style={styles.orgMapBtn}
                >
                  <Text style={styles.orgMapText}>Code map</Text>
                </TouchableOpacity>
              ) : null}
            </Row>
          </TouchableOpacity>
        )) : <Text style={styles.emptyItalic}>No projects yet.</Text>}
      </Section>

      <TouchableOpacity
        testID="org-audit"
        accessibilityRole="button"
        accessibilityLabel="Activity, who did what and when"
        onPress={() => navigation.navigate("Audit")}
        style={styles.orgActivity}
      >
        <View style={styles.flex1}>
          <Text style={styles.audEmptyTitle}>Activity</Text>
          <Text style={styles.orgActivityHint}>Who did what, and when</Text>
        </View>
        <Icon name="chevronRight" size={18} color={t.textMuted} />
      </TouchableOpacity>

      <Section title="Skills learned">
        {learned.length ? learned.map((s) => (
          <View key={s.name} style={styles.orgSkill}>
            <Icon name={s.status === "active" ? "sparkle" : "clock"} size={14} color={s.status === "active" ? t.accent : t.textMuted} />
            <View style={styles.flex1}>
              <Text style={styles.orgSkillName} numberOfLines={1}>{s.name}</Text>
              {s.description ? <Text style={styles.orgSkillMeta} numberOfLines={2}>{s.description}</Text> : null}
            </View>
            <Text style={styles.orgSkillMeta}>{s.status}</Text>
          </View>
        )) : <Text style={styles.emptyItalic}>Nothing learned yet.</Text>}
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
