import React, { useState } from "react"
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api } from "../api/client"
import Icon from "../components/Icon"
import { useTheme } from "../lib/useTheme"
import { useStyles } from "./styles"

type Props = NativeStackScreenProps<RootStackParamList, "HostEdit">

/**
 * Add or edit an SSH host. "Test connection" is offered before saving because a
 * bad host is otherwise only discovered later, when the chat list fails to load.
 */
export default function HostEditScreen({ route, navigation }: Props) {
  const styles = useStyles()
  const t = useTheme()
  const existing = route.params?.host
  const [label, setLabel] = useState(existing?.label || "")
  const [hostname, setHostname] = useState(existing?.host || "")
  const [user, setUser] = useState(existing?.user || "")
  const [port, setPort] = useState(String(existing?.port || 22))
  const [password, setPassword] = useState("")
  const [keyFile, setKeyFile] = useState(existing?.keyFile || "")
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState("")
  const [ok, setOk] = useState<boolean | null>(null)
  const [error, setError] = useState("")

  function cfg() {
    return {
      id: existing?.id,
      label: label.trim(),
      host: hostname.trim(),
      user: user.trim(),
      port: Number(port) || 22,
      auth: (keyFile.trim() ? "key" : "password") as "key" | "password",
      keyFile: keyFile.trim(),
      ...(password ? { password } : {}),
    }
  }

  const incomplete = !label.trim() || !hostname.trim() || !user.trim()

  async function test() {
    setError("")
    setStatus("Testing…")
    setOk(null)
    setBusy(true)
    try {
      const r = await api.hostsTest(cfg())
      setStatus(r.ok ? "Connected" : r.message || "Could not connect")
      setOk(!!r.ok)
    } catch (e) {
      setStatus("")
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function save() {
    setError("")
    setBusy(true)
    try {
      const r = await api.hostsSave(cfg())
      if (r?.error) throw new Error(r.error)
      navigation.goBack()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView style={styles.screen} keyboardShouldPersistTaps="handled">
        <Text style={styles.label}>Name</Text>
        <TextInput testID="host-label" style={styles.input} placeholder="Mac Personal" value={label} onChangeText={setLabel} />

        <Text style={styles.label}>Hostname or IP</Text>
        <TextInput
          testID="host-address"
          style={styles.input}
          placeholder="100.x.y.z or mac.tailnet.ts.net"
          autoCapitalize="none"
          autoCorrect={false}
          value={hostname}
          onChangeText={setHostname}
        />

        <Text style={styles.label}>User</Text>
        <TextInput
          testID="host-user"
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
          value={user}
          onChangeText={setUser}
        />

        <Text style={styles.label}>Port</Text>
        <TextInput testID="host-port" style={styles.input} keyboardType="number-pad" value={port} onChangeText={setPort} />

        <Text style={styles.label}>SSH key file (leave blank to use a password)</Text>
        <TextInput
          testID="host-keyfile"
          style={styles.input}
          placeholder="~/.ssh/id_ed25519"
          autoCapitalize="none"
          autoCorrect={false}
          value={keyFile}
          onChangeText={setKeyFile}
        />

        {!keyFile.trim() ? (
          <>
            <Text style={styles.label}>Password</Text>
            <TextInput
              testID="host-password"
              style={styles.input}
              secureTextEntry
              value={password}
              onChangeText={setPassword}
              placeholder={existing ? "unchanged" : ""}
            />
          </>
        ) : null}

        {status ? (
          <View style={[styles.drawerCheckRow, { marginTop: 12 }]}>
            {ok === null ? null : <Icon name={ok ? "check" : "warning"} size={16} color={ok ? t.accent : t.danger} />}
            <Text style={styles.hint}>{status}</Text>
          </View>
        ) : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}

        <View style={{ flexDirection: "row", gap: 10, marginTop: 20 }}>
          <TouchableOpacity
            testID="host-test"
            style={[styles.button, { flex: 1, marginTop: 0, backgroundColor: t.chipBg, borderWidth: 1, borderColor: t.border }, incomplete || busy ? { opacity: 0.5 } : null]}
            onPress={test}
            disabled={incomplete || busy}
          >
            <Text style={[styles.buttonText, { color: t.textMuted }]}>Test</Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID="host-save"
            style={[styles.button, { flex: 1, marginTop: 0 }, incomplete || busy ? { opacity: 0.5 } : null]}
            onPress={save}
            disabled={incomplete || busy}
          >
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Save</Text>}
          </TouchableOpacity>
        </View>
        <View style={{ height: 40 }} />
      </ScrollView>
    </KeyboardAvoidingView>
  )
}
