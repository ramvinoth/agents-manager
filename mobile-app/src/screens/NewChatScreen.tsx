import React, { useCallback, useEffect, useState } from "react"
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api, type Host, type Project } from "../api/client"
import { composerPrefs, currentHost, setComposerPrefs } from "../state/config"
import Dropdown from "../components/Dropdown"
import { useStyles } from "./styles"

type Props = NativeStackScreenProps<RootStackParamList, "NewChat">

const LOCAL: Host = { id: "local", label: "This machine", host: "localhost", user: "", port: 0, auth: "password", keyFile: "" }
const MODES = [
  { v: "acceptEdits", label: "Accept edits" },
  { v: "default", label: "Ask" },
  { v: "plan", label: "Plan" },
  { v: "bypassPermissions", label: "Bypass" },
]

function short(p: string): string {
  const parts = p.split("/").filter(Boolean)
  return parts.length ? parts[parts.length - 1] : p
}

// Start a brand-new agent session: pick the host, working directory and first
// message, then POST /api/new-session and drop straight into the thread —
// the mobile equivalent of the web's New Session dialog.
export default function NewChatScreen({ navigation }: Props) {
  const styles = useStyles()
  const [hosts, setHosts] = useState<Host[]>([LOCAL])
  const [host, setHost] = useState(currentHost())
  const [projects, setProjects] = useState<Project[]>([])
  const [cwd, setCwd] = useState("")
  const [message, setMessage] = useState("")
  const [title, setTitle] = useState("")
  const [mode, setModeState] = useState(composerPrefs().mode)
  const setMode = (v: string) => {
    setModeState(v)
    setComposerPrefs({ mode: v })
  }
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    api
      .hosts()
      .then((r) => setHosts([LOCAL, ...r]))
      .catch(() => {})
  }, [])

  const loadProjects = useCallback(async () => {
    try {
      const p = await api.projects(host)
      setProjects(Array.isArray(p) ? p : [])
      if (!cwd && p.length) setCwd(p[0].cwd)
    } catch {
      setProjects([])
    }
  }, [host]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    loadProjects()
  }, [loadProjects])

  async function start() {
    const msg = message.trim()
    if (!msg || busy) return
    setError("")
    setBusy(true)
    try {
      const res = await api.newSession({
        message: msg,
        cwd: cwd.trim() || "~",
        mode,
        host,
        agent: "claude",
        title: title.trim() || undefined,
      })
      // Land in the new thread; its focus effect fetches status and starts
      // polling the just-started run.
      navigation.replace("Thread", {
        host,
        label: title.trim() || short(cwd) || res.session.slice(0, 8),
        path: res.path,
      })
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView style={styles.screen} keyboardShouldPersistTaps="handled">
        <Text style={styles.label}>Host</Text>
        <Dropdown
          testIDPrefix="newchat-host"
          value={host}
          options={hosts.map((h) => ({ v: h.id, label: h.label }))}
          onChange={(v) => {
            setHost(v)
            setCwd("")
          }}
        />

        <Text style={styles.label}>Working directory</Text>
        <TextInput
          testID="newchat-cwd"
          style={styles.input}
          placeholder="~/path/to/project"
          autoCapitalize="none"
          autoCorrect={false}
          value={cwd}
          onChangeText={setCwd}
        />
        {projects.length ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
            {projects.slice(0, 8).map((p) => (
              <TouchableOpacity key={p.cwd} style={styles.pill} onPress={() => setCwd(p.cwd)}>
                <Text style={styles.pillText} numberOfLines={1}>
                  {short(p.cwd)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        ) : null}

        <Text style={styles.label}>Chat name (optional)</Text>
        <TextInput
          testID="newchat-title"
          style={styles.input}
          placeholder="e.g. refactor auth"
          value={title}
          onChangeText={setTitle}
        />

        <Text style={styles.label}>Permission mode</Text>
        <Dropdown testIDPrefix="newchat-mode" value={mode} options={MODES} onChange={setMode} />

        <Text style={styles.label}>First message</Text>
        <TextInput
          testID="newchat-message"
          style={[styles.input, { minHeight: 96, textAlignVertical: "top" }]}
          placeholder="What should the agent do?"
          multiline
          value={message}
          onChangeText={setMessage}
        />

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <TouchableOpacity
          testID="newchat-start"
          style={[styles.button, !message.trim() || busy ? { opacity: 0.5 } : null]}
          onPress={start}
          disabled={busy || !message.trim()}
        >
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Start chat</Text>}
        </TouchableOpacity>
        <Text style={styles.hint}>Creates a new session on {host === "local" ? "this machine" : host}.</Text>
        <View style={{ height: 40 }} />
      </ScrollView>
    </KeyboardAvoidingView>
  )
}
