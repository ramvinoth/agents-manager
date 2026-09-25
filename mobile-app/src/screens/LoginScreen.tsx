import React, { useEffect, useState } from "react"
import { ActivityIndicator, Text, TextInput, TouchableOpacity, View } from "react-native"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api } from "../api/client"
import { serverUrl, setToken } from "../state/config"
import ServerPicker from "../components/ServerPicker"
import { useTheme } from "../lib/useTheme"
import { registerForPush } from "../lib/notify"
import { useStyles } from "./styles"

type Props = NativeStackScreenProps<RootStackParamList, "Login">

export default function LoginScreen({ navigation }: Props) {
  const styles = useStyles()
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [signupOpen, setSignupOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const t = useTheme()
  const [serverOpen, setServerOpen] = useState(false)
  const [reachable, setReachable] = useState(true)

  useEffect(() => {
    let cancelled = false
    api.authState().then((s) => {
      if (cancelled) return
      setSignupOpen(s.signupOpen)
      setReachable(true)
    }).catch(() => { if (!cancelled) setReachable(false) })
    return () => { cancelled = true }
  }, [])

  async function submit() {
    const server = serverUrl()
    setError("")
    setBusy(true)
    try {
      const res = signupOpen ? await api.signup(username, password) : await api.signin(username, password)
      if (serverUrl() !== server) return
      if (!res.token) throw new Error("Server did not return a token")
      await setToken(res.token)
      // Register this device for background push now that we're authenticated.
      registerForPush((tok) => api.pushRegister(tok)).catch(() => {})
      navigation.replace("Home")
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={styles.screen}>
      <Text style={styles.label}>Username</Text>
      <TextInput
        testID="login-username"
        accessibilityLabel="login-username"
        style={styles.input}
        autoCapitalize="none"
        autoCorrect={false}
        value={username}
        onChangeText={setUsername}
      />
      <Text style={styles.label}>Password</Text>
      <TextInput
        testID="login-password"
        accessibilityLabel="login-password"
        style={styles.input}
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />
      {signupOpen ? <Text style={styles.hint}>First run on this instance — this creates the owner account.</Text> : null}
      {!reachable ? (
        <Text testID="login-unreachable" style={styles.error}>
          Can't reach this server. It may be down — use “Change server” below to switch or add a server.
        </Text>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <TouchableOpacity
        testID="login-submit"
        accessibilityLabel="login-submit"
        style={styles.button}
        onPress={submit}
        disabled={busy || !username || !password}
      >
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>{signupOpen ? "Create account" : "Sign in"}</Text>}
      </TouchableOpacity>
      <TouchableOpacity
        testID="login-change-server"
        accessibilityLabel="change-server"
        style={{ marginTop: 22, alignItems: "center" }}
        onPress={() => setServerOpen(true)}
      >
        <Text style={{ color: t.accent, fontWeight: "600" }}>Change server</Text>
        <Text style={[styles.hint, { textAlign: "center", marginTop: 2 }]} numberOfLines={1}>
          {serverUrl() || "—"}
        </Text>
      </TouchableOpacity>
      <ServerPicker visible={serverOpen} onClose={() => setServerOpen(false)} navigation={navigation} />
    </View>
  )
}
