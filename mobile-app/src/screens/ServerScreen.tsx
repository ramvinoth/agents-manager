import React, { useState } from "react"
import { ActivityIndicator, ScrollView, Text, TextInput, TouchableOpacity } from "react-native"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { addServer, switchServer, token } from "../state/config"
import { api } from "../api/client"
import { parsePairLink } from "../lib/pairLink"
import { pairFromLink } from "../state/signin"
import { useStyles } from "../lib/styles"
import { useTheme } from "../lib/useTheme"
import { userError } from "../lib/errors"
import PairScanner from "../components/PairScanner"

type Props = NativeStackScreenProps<RootStackParamList, "Server">

/**
 * Connect a backend. Two entry points share this screen:
 *  - "initial" (default): the cold-start flow when no server is configured yet.
 *  - "add": reached from the Profile server picker to save ANOTHER server.
 * Both add + switch to the server and probe reachability, then hand off to Login
 * (the new server is tokenless until you sign in — the token is stored per
 * server via setToken on the now-active entry).
 */
export default function ServerScreen({ navigation }: Props) {
  const styles = useStyles()
  const t = useTheme()
  const [name, setName] = useState("")
  const [url, setUrl] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [scanning, setScanning] = useState(false)

  async function paired(link: string) {
    setScanning(false)
    if (await pairFromLink(link)) navigation.reset({ index: 0, routes: [{ name: "Home" }] })
  }

  async function connect() {
    setError("")
    setBusy(true)
    try {
      // A pasted pairing link (web Profile → Pair a phone → copy) signs in
      // directly, the same as scanning its QR.
      if (parsePairLink(url)) {
        if (await pairFromLink(url)) navigation.reset({ index: 0, routes: [{ name: "Home" }] })
        return
      }
      const entry = await addServer(url, name)
      await switchServer(entry.id)
      // Reachability probe against a public endpoint (uses the now-active server).
      await api.authState()
      // Re-adding a server you're already signed into (addServer dedupes by URL)
      // keeps its token — skip Login and go straight to Home. Only a tokenless
      // (brand-new) server needs sign-in.
      navigation.replace(token() ? "Home" : "Login")
    } catch (e) {
      setError(userError(e, "this server", "reach"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <ScrollView
      style={styles.screen}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      automaticallyAdjustKeyboardInsets
    >
      <TouchableOpacity testID="server-scan" accessibilityLabel="Scan pairing QR" style={[styles.button, { marginTop: 4 }]} onPress={() => setScanning(true)}>
        <Text style={styles.buttonText}>Scan pairing QR</Text>
      </TouchableOpacity>
      <Text style={styles.hint}>On your computer open Manager → Profile → Pair a phone. Signs you in, no password.</Text>
      <Text style={[styles.hint, { marginTop: 20 }]}>Or enter the server address:</Text>
      <Text style={styles.label}>Name (optional)</Text>
      <TextInput
        testID="server-name"
        accessibilityLabel="Server name"
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
        Reach your self-hosted server over Tailscale — its tailnet IP or MagicDNS name, port 8091. A pasted
        pairing link works here too.
      </Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <TouchableOpacity testID="server-connect" accessibilityLabel="server-connect" style={styles.button} onPress={connect} disabled={busy || !url}>
        {busy ? <ActivityIndicator color={t.onAccent} /> : <Text style={styles.buttonText}>Connect</Text>}
      </TouchableOpacity>
      <PairScanner visible={scanning} onClose={() => setScanning(false)} onScan={paired} />
    </ScrollView>
  )
}