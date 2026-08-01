import React, { useState } from "react"
import { ActivityIndicator, Text, TextInput, TouchableOpacity, View } from "react-native"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { addServer, switchServer, token } from "../state/config"
import { api } from "../api/client"
import { useStyles } from "./styles"

type Props = NativeStackScreenProps<RootStackParamList, "Server">

/**
 * Connect a backend. Two entry points share this screen:
 *  - "initial" (default): the cold-start flow when no server is configured yet.
 *  - "add": reached from the Profile server picker to save ANOTHER server.
 * Both add + switch to the server and probe reachability, then hand off to Login
 * (the new server is tokenless until you sign in — the token is stored per
 * server via setToken on the now-active entry).
 */
export default function ServerScreen({ route, navigation }: Props) {
  const styles = useStyles()
  const [name, setName] = useState("")
  const [url, setUrl] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  async function connect() {
    setError("")
    setBusy(true)
    try {
      const entry = await addServer(url, name)
      await switchServer(entry.id)
      // Reachability probe against a public endpoint (uses the now-active server).
      await api.authState()
      // Re-adding a server you're already signed into (addServer dedupes by URL)
      // keeps its token — skip Login and go straight to Home. Only a tokenless
      // (brand-new) server needs sign-in.
      navigation.replace(token() ? "Home" : "Login")
    } catch (e) {
      setError(`Can't reach server: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={styles.screen}>
      <Text style={styles.label}>Name (optional)</Text>
      <TextInput
        testID="server-name"
        accessibilityLabel="server-name"
        style={styles.input}
        placeholder="Home, Cloud…"
        autoCapitalize="words"
        autoCorrect={false}
        value={name}
        onChangeText={setName}
      />
      <Text style={styles.label}>Server URL</Text>
      <TextInput
        testID="server-url"
        accessibilityLabel="server-url"
        style={styles.input}
        placeholder="http://100.x.y.z:8091  (Tailscale)"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        value={url}
        onChangeText={setUrl}
      />
      <Text style={styles.hint}>
        Reach your self-hosted server over Tailscale — its tailnet IP or MagicDNS name, port 8091.
      </Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <TouchableOpacity testID="server-connect" accessibilityLabel="server-connect" style={styles.button} onPress={connect} disabled={busy || !url}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Connect</Text>}
      </TouchableOpacity>
    </View>
  )
}
