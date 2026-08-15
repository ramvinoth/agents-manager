import React, { useCallback, useEffect, useState } from "react"
import { ActivityIndicator, Alert, ScrollView, Switch, Text, TouchableOpacity, View } from "react-native"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api, type Approval, type AuditEntry, type Employee, type HarmanConfig, type LearnedSkill, type OrgProject } from "../api/client"
import { setToken } from "../state/config"
import Icon from "../components/Icon"
import { useTheme } from "../lib/useTheme"

type Props = NativeStackScreenProps<RootStackParamList, "Org">

/**
 * OrgScreen — the CEO dashboard for the "empire": the employee roster, projects,
 * the open Approvals queue Harman feeds (Approve/Deny), and a read-only audit
 * timeline. The full unfiltered board is one tap away. Read-heavy; mutations are
 * limited to approving/denying and creating employees/projects (manager authority,
 * enforced server-side).
 */
export default function OrgScreen({ navigation }: Props) {
  const t = useTheme()
  const [employees, setEmployees] = useState<Employee[]>([])
  const [projects, setProjects] = useState<OrgProject[]>([])
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const [harman, setHarman] = useState<HarmanConfig | null>(null)
  const [skills, setSkills] = useState<LearnedSkill[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  const load = useCallback(async () => {
    setError("")
    try {
      const [e, p, a, au, h, sk] = await Promise.all([
        api.orgEmployees(),
        api.orgProjects(),
        api.orgApprovals(),
        api.orgAudit(50),
        api.orgHarman().catch(() => null),
        api.orgSkills().catch(() => ({ skills: [] as LearnedSkill[] })),
      ])
      setEmployees(e.employees || [])
      setProjects(p.projects || [])
      setApprovals(a.approvals || [])
      setAudit(au.audit || [])
      setHarman(h)
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

  useEffect(() => {
    navigation.setOptions({
      title: "Company",
      headerRight: () => (
        <TouchableOpacity testID="org-open-board" onPress={() => navigation.navigate("Kanban", { title: "Board" })} hitSlop={8} style={{ marginRight: 4 }}>
          <Icon name="folder" size={22} color={t.accent} />
        </TouchableOpacity>
      ),
    })
  }, [navigation, t])

  function promptAdd(kind: "employee" | "project") {
    const AlertAny = Alert as unknown as { prompt?: (t: string, m: string | undefined, cb: (v: string) => void) => void }
    if (!AlertAny.prompt) return
    AlertAny.prompt(kind === "employee" ? "New employee" : "New project", "Name", async (name: string) => {
      const n = (name || "").trim()
      if (!n) return
      try {
        if (kind === "employee") await api.orgCreateEmployee({ name: n })
        else await api.orgCreateProject({ name: n })
        load()
      } catch (e) { setError((e as Error).message) }
    })
  }

  async function resolve(a: Approval, resolution: "approved" | "denied") {
    setApprovals((cur) => cur.filter((x) => x.id !== a.id))
    try {
      await api.orgResolveApproval({ id: a.id, resolution })
      load()
    } catch { load() }
  }

  async function patchHarman(patch: Partial<HarmanConfig>) {
    if (!harman) return
    const next = { ...harman, ...patch }
    setHarman(next) // optimistic
    try {
      const saved = await api.orgSetHarman(patch)
      setHarman(saved)
    } catch { load() }
  }

  function toggleManaged(projectId: number) {
    if (!harman) return
    const has = harman.projects.includes(projectId)
    patchHarman({ projects: has ? harman.projects.filter((p) => p !== projectId) : [...harman.projects, projectId] })
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
    <ScrollView style={{ flex: 1, backgroundColor: t.bg }} contentContainerStyle={{ padding: 16 }}>
      {error ? <Text style={{ color: t.danger, marginBottom: 12 }}>{error}</Text> : null}

      {harman ? (
        <Section title="Harman (manager)">
          <Row>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: t.text, fontWeight: "600" }}>Autonomous manager</Text>
                <Text style={{ color: t.textMuted, fontSize: 12, marginTop: 2 }}>
                  {harman.enabled
                    ? (harman.projects.length ? `Managing ${harman.projects.length} project(s) · up to ${harman.budget} at once` : "On, but no projects assigned — inert")
                    : "Off"}
                </Text>
              </View>
              <Switch value={harman.enabled} onValueChange={(v) => patchHarman({ enabled: v })} />
            </View>
            {/* Which projects Harman manages (auto-assign + spawn). Empty = does nothing. */}
            {projects.length ? (
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
                {projects.map((p) => {
                  const on = harman.projects.includes(p.id)
                  return (
                    <TouchableOpacity
                      key={p.id}
                      testID={`harman-proj-${p.id}`}
                      onPress={() => toggleManaged(p.id)}
                      style={{ borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5, backgroundColor: on ? t.accent : t.chipBg }}
                    >
                      <Text style={{ color: on ? "#fff" : t.text, fontSize: 12 }}>{p.name}</Text>
                    </TouchableOpacity>
                  )
                })}
              </View>
            ) : null}
          </Row>
        </Section>
      ) : null}

      <Section title="Approvals" >
        {approvals.length ? approvals.map((a) => (
          <Row key={a.id}>
            <Text style={{ color: t.text, fontWeight: "600" }}>{a.summary || a.kind}</Text>
            <Text style={{ color: t.textMuted, fontSize: 12, marginTop: 2 }}>{a.kind} · {a.created_by}</Text>
            <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
              <TouchableOpacity testID={`org-approve-${a.id}`} onPress={() => resolve(a, "approved")} style={{ flex: 1, backgroundColor: t.accent, borderRadius: 8, padding: 8, alignItems: "center" }}>
                <Text style={{ color: "#fff", fontWeight: "600" }}>Approve</Text>
              </TouchableOpacity>
              <TouchableOpacity testID={`org-deny-${a.id}`} onPress={() => resolve(a, "denied")} style={{ flex: 1, backgroundColor: t.dangerBg, borderRadius: 8, padding: 8, alignItems: "center" }}>
                <Text style={{ color: t.danger, fontWeight: "600" }}>Deny</Text>
              </TouchableOpacity>
            </View>
          </Row>
        )) : <Text style={{ color: t.textMuted, fontStyle: "italic" }}>Nothing needs your approval.</Text>}
      </Section>

      <Section title="Employees" onAdd={() => promptAdd("employee")}>
        {employees.length ? employees.map((e) => (
          <Row key={e.id}>
            <Text style={{ color: t.text, fontWeight: "600" }}>{e.avatar ? e.avatar + " " : ""}{e.name}</Text>
            <Text style={{ color: t.textMuted, fontSize: 12, marginTop: 2 }}>{e.role || "—"} · {e.status}</Text>
          </Row>
        )) : <Text style={{ color: t.textMuted, fontStyle: "italic" }}>No employees yet.</Text>}
      </Section>

      <Section title="Projects" onAdd={() => promptAdd("project")}>
        {projects.length ? projects.map((p) => (
          <TouchableOpacity key={p.id} onPress={() => navigation.navigate("Kanban", { project: p.id, title: p.name })}>
            <Row>
              <Text style={{ color: t.text, fontWeight: "600" }}>{p.name}</Text>
              {p.description ? <Text style={{ color: t.textMuted, fontSize: 12, marginTop: 2 }} numberOfLines={1}>{p.description}</Text> : null}
            </Row>
          </TouchableOpacity>
        )) : <Text style={{ color: t.textMuted, fontStyle: "italic" }}>No projects yet.</Text>}
      </Section>

      <Section title="Skills learned">
        {skills.length ? skills.map((s) => (
          <View key={s.id} style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 }}>
            <Icon name={s.status === "active" ? "sparkle" : "clock"} size={14} color={s.status === "active" ? t.accent : t.textMuted} />
            <Text style={{ color: t.text, fontSize: 13, flex: 1 }} numberOfLines={1}>{s.name}</Text>
            <Text style={{ color: t.textMuted, fontSize: 11 }}>{s.status}</Text>
          </View>
        )) : <Text style={{ color: t.textMuted, fontStyle: "italic" }}>Nothing learned yet.</Text>}
      </Section>

      <Section title="Audit">
        {audit.length ? audit.map((a) => (
          <View key={a.id} style={{ flexDirection: "row", gap: 8, paddingVertical: 4 }}>
            <Text style={{ color: t.textMuted, fontSize: 12, flex: 1 }} numberOfLines={1}>
              <Text style={{ color: t.text }}>{a.actor}</Text> {a.action} <Text style={{ color: t.textMuted }}>· {a.outcome}</Text>
            </Text>
          </View>
        )) : <Text style={{ color: t.textMuted, fontStyle: "italic" }}>No activity yet.</Text>}
      </Section>
    </ScrollView>
  )
}
