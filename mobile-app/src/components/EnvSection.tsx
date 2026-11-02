import React, { useEffect, useState } from "react"
import { ActivityIndicator, Alert, Text, TextInput, View } from "react-native"
import { TouchableOpacity } from "./Tracked"
import Icon from "./Icon"
import { api } from "../api/client"
import { useHost } from "../lib/useHost"
import { userError } from "../lib/errors"
import { useStyles } from "../lib/styles"
import { useTheme } from "../lib/useTheme"

/**
 * Per-host environment variables injected into that machine's terminal and
 * agent runs (e.g. GH_TOKEN). Twin of the web EnvDialog; viewer/hostenv.py
 * owns storage and validation. Names are listed; a value is fetched only when
 * revealed, and re-masked after a save. Deleting confirms first — a variable
 * is often a credential and removing it breaks that service's runs.
 */
export default function EnvSection() {
  const styles = useStyles()
  const t = useTheme()
  const { host, label } = useHost()
  const [keys, setKeys] = useState<string[] | null>(null)
  const [shown, setShown] = useState<Record<string, string>>({}) // key -> revealed/edited value
  const [newKey, setNewKey] = useState("")
  const [newVal, setNewVal] = useState("")
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")

  useEffect(() => {
    setKeys(null); setShown({}); setError("")
    api.env(host).then((d) => setKeys(d.keys || [])).catch((e) => { setKeys([]); setError(userError(e, "environment variables")) })
  }, [host])

  const hide = (k: string) => setShown((s) => { const n = { ...s }; delete n[k]; return n })

  async function reveal(k: string) {
    if (k in shown) { hide(k); return }
    setError("")
    try {
      const d = await api.envValue(host, k)
      setShown((s) => ({ ...s, [k]: d.value }))
    } catch (e) {
      setError(userError(e, k))
    }
  }

  async function save(k: string, v: string): Promise<boolean> {
    const key = k.trim()
    if (!key || !v) { setError("Name and value are both required."); return false }
    setBusy(key); setError("")
    try {
      const d = await api.envSet(host, key, v)
      setKeys(d.keys || [])
      hide(key)
      return true
    } catch (e) {
      setError(userError(e, key, "save"))
      return false
    } finally {
      setBusy("")
    }
  }

  function remove(k: string) {
    Alert.alert(`Delete ${k}?`, `Runs on ${label} lose it right away. If it's a credential, that service stops working there.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete", style: "destructive", onPress: async () => {
          setBusy(k); setError("")
          try {
            const d = await api.envUnset(host, k)
            setKeys(d.keys || [])
            hide(k)
          } catch (e) {
            setError(userError(e, k, "delete"))
          } finally {
            setBusy("")
          }
        },
      },
    ])
  }

  const add = async () => {
    if (await save(newKey, newVal)) { setNewKey(""); setNewVal("") }
  }

  return (
    <View testID="integration-env">
      <Text style={styles.sheetSection}>ENVIRONMENT · {label.toUpperCase()}</Text>
      <Text style={styles.sheetHint}>
        Variables this machine's terminal and agent runs get (e.g. GH_TOKEN for GitHub). Stored privately on the
        server; values stay hidden until you reveal them.
      </Text>
      <View style={styles.spCard}>
        {keys === null ? <View style={styles.igSection}><ActivityIndicator /></View> : null}
        {keys?.length === 0 ? (
          <View style={styles.igSection}><Text style={styles.igHint}>No variables set on {label} yet.</Text></View>
        ) : null}
        {keys?.map((k, i) => {
          const revealed = k in shown
          return (
            <View key={k} testID={`env-${k}`} style={[styles.igSection, i > 0 && styles.igHairTop]}>
              <View style={styles.rowCenter}>
                <Text style={[styles.ssRowLabel, styles.flex1]} numberOfLines={1}>{k}</Text>
                {busy === k ? <ActivityIndicator /> : null}
                <TouchableOpacity testID={`env-reveal-${k}`} hitSlop={8} style={styles.igIconBtn} disabled={!!busy}
                  onPress={() => reveal(k)} accessibilityLabel={revealed ? `Hide ${k}` : `Reveal ${k}`}>
                  <Icon name={revealed ? "close" : "eye"} size={16} color={t.textMuted} />
                </TouchableOpacity>
                <TouchableOpacity testID={`env-delete-${k}`} hitSlop={8} style={styles.igIconBtn} disabled={!!busy}
                  onPress={() => remove(k)} accessibilityLabel={`Delete ${k}`}>
                  <Icon name="trash" size={16} color={t.textMuted} />
                </TouchableOpacity>
              </View>
              {revealed ? (
                <View style={[styles.rowCenter, { gap: 12, marginTop: 6 }]}>
                  <TextInput testID={`env-value-${k}`} style={[styles.ssInput, styles.flex1]} value={shown[k]}
                    onChangeText={(v) => setShown((s) => ({ ...s, [k]: v }))}
                    autoCapitalize="none" autoCorrect={false} spellCheck={false} />
                  <TouchableOpacity testID={`env-save-${k}`} disabled={!!busy || !shown[k]} onPress={() => save(k, shown[k])}>
                    <Text style={[styles.igLink, (!!busy || !shown[k]) && styles.faded]}>Save</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <Text style={styles.igHint}>••••••••••••</Text>
              )}
            </View>
          )
        })}
        <View style={[styles.igSection, !!keys?.length && styles.igHairTop]}>
          <TextInput testID="env-new-key" style={styles.ssInput} value={newKey} onChangeText={setNewKey}
            placeholder="Name, e.g. GH_TOKEN" placeholderTextColor={t.textMuted}
            autoCapitalize="characters" autoCorrect={false} spellCheck={false} />
          <View style={[styles.rowCenter, { gap: 12, marginTop: 6 }]}>
            <TextInput testID="env-new-value" style={[styles.ssInput, styles.flex1]} value={newVal} onChangeText={setNewVal}
              placeholder="Value" placeholderTextColor={t.textMuted} secureTextEntry
              autoCapitalize="none" autoCorrect={false} spellCheck={false} onSubmitEditing={add} />
            <TouchableOpacity testID="env-add" disabled={!!busy || !newKey.trim() || !newVal}
              style={[styles.ssAddBtn, (!!busy || !newKey.trim() || !newVal) && styles.faded]} onPress={add}>
              {busy && busy === newKey.trim() ? <ActivityIndicator /> : <Text style={styles.ssAddBtnText}>Add</Text>}
            </TouchableOpacity>
          </View>
        </View>
      </View>
      {error ? <Text testID="env-error" style={[styles.sheetHint, { color: t.danger }]}>{error}</Text> : null}
    </View>
  )
}
