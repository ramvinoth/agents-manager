/**
 * MarketplaceSheet — browse and install from vetted sources: MCP tools from
 * the official MCP Registry, skills from anthropics/skills. Search → pick an
 * entry → read who publishes it, fill its inputs, choose where it applies →
 * Install. The server rebuilds the install from the source's own record, so
 * nothing typed here becomes a command.
 */
import React, { useCallback, useEffect, useState } from "react"
import { ActivityIndicator, Alert, FlatList, Linking, Modal, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native"
import { api, type MarketItem } from "../api/client"
import { filledValues, installNote, missingInput, scopes, SCOPE_LABEL, type InstallScope, type MarketKind } from "../lib/marketplace"
import { userError } from "../lib/errors"
import { useTheme } from "../lib/useTheme"
import { useStyles } from "../lib/styles"
import Icon from "./Icon"

const SOURCE: Record<MarketKind, string> = {
  mcp: "Official MCP Registry · registry.modelcontextprotocol.io",
  skills: "Anthropic skills · github.com/anthropics/skills",
}

export default function MarketplaceSheet({ kind, cwd, session, onClose, onInstalled }: {
  kind: MarketKind
  /** The session's folder; offers "This project" when present. */
  cwd?: string
  /** An open local Claude chat; offers "This chat" (its own plugin) when present. */
  session?: string
  onClose: () => void
  onInstalled: () => void
}) {
  const styles = useStyles()
  const t = useTheme()
  const [q, setQ] = useState("")
  const [items, setItems] = useState<MarketItem[] | null>(null)
  const [cursor, setCursor] = useState<string | undefined>()
  const [error, setError] = useState("")
  const [more, setMore] = useState(false)
  const [pick, setPick] = useState<MarketItem | null>(null)

  const search = useCallback((text: string, after?: string) => {
    setError("")
    if (after) setMore(true)
    else setItems(null)
    const call = kind === "mcp" ? api.marketMcp(text, after) : api.marketSkills(text)
    call
      .then(p => { setItems(prev => (after && prev ? [...prev, ...p.items] : p.items)); setCursor(p.cursor || undefined) })
      .catch(e => setError(userError(e, "the marketplace")))
      .finally(() => setMore(false))
  }, [kind])

  // Debounced: the registry is a public service, one call per pause in typing.
  useEffect(() => {
    const h = setTimeout(() => search(q.trim()), q ? 350 : 0)
    return () => clearTimeout(h)
  }, [q, search])

  const title = kind === "mcp" ? "MCP tools" : "Skills"
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={pick ? () => setPick(null) : onClose}>
      <View style={styles.page}>
        <View style={{ flexDirection: "row", alignItems: "center", padding: 16, paddingBottom: 8, gap: 8 }}>
          {pick ? (
            <TouchableOpacity testID="market-back" onPress={() => setPick(null)} hitSlop={10}><Icon name="chevronLeft" size={22} color={t.accent} /></TouchableOpacity>
          ) : null}
          <Text style={{ flex: 1, fontSize: 18, fontWeight: "700", color: t.text }} numberOfLines={1}>{pick ? pick.title : `${title} marketplace`}</Text>
          <TouchableOpacity testID="market-close" onPress={onClose} hitSlop={10}><Icon name="close" size={22} color={t.textMuted} /></TouchableOpacity>
        </View>
        {pick ? (
          <Install kind={kind} item={pick} cwd={cwd} session={session} onDone={() => { onInstalled(); onClose() }} />
        ) : (
          <>
            <View style={{ paddingHorizontal: 16 }}>
              <TextInput testID="market-search" style={styles.input} value={q} onChangeText={setQ} placeholder={`Search ${title.toLowerCase()}`}
                placeholderTextColor={t.textMuted} autoCapitalize="none" autoCorrect={false} clearButtonMode="while-editing" />
              <Text style={[styles.hint, { marginTop: 6 }]}>{SOURCE[kind]}</Text>
            </View>
            {error ? (
              <View style={{ padding: 24, alignItems: "center", gap: 10 }}>
                <Text testID="market-error" style={{ color: t.textMuted, textAlign: "center" }}>{error}</Text>
                <TouchableOpacity testID="market-retry" onPress={() => search(q.trim())}><Text style={{ color: t.accent, fontWeight: "600" }}>Try again</Text></TouchableOpacity>
              </View>
            ) : !items ? (
              <ActivityIndicator color={t.textMuted} style={{ marginTop: 24 }} />
            ) : (
              <FlatList
                testID="market-list"
                data={items}
                keyExtractor={i => i.id}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={{ paddingBottom: 40 }}
                ListEmptyComponent={<Text style={styles.capEmpty}>Nothing matches “{q}”.</Text>}
                onEndReachedThreshold={0.4}
                onEndReached={() => { if (cursor && !more) search(q.trim(), cursor) }}
                ListFooterComponent={more ? <ActivityIndicator color={t.textMuted} style={{ margin: 16 }} /> : null}
                renderItem={({ item }) => (
                  <TouchableOpacity testID={`market-item-${item.id}`} style={styles.capRow} onPress={() => setPick(item)}>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.capRowName, { color: t.text }]} numberOfLines={1}>{item.title}</Text>
                      <Text style={[styles.capRowDesc, { color: t.textMuted }]} numberOfLines={2}>{item.description}</Text>
                    </View>
                    <Text style={styles.capBadge}>{installNote(kind, item)}</Text>
                  </TouchableOpacity>
                )}
              />
            )}
          </>
        )}
      </View>
    </Modal>
  )
}

function Install({ kind, item, cwd, session, onDone }: { kind: MarketKind; item: MarketItem; cwd?: string; session?: string; onDone: () => void }) {
  const styles = useStyles()
  const t = useTheme()
  const inputs = item.inputs ?? []
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(inputs.map(i => [i.name, i.default || ""])))
  const offered = scopes(cwd, !!session)
  // Default to the widest-but-scoped choice: this project when known, else all sessions.
  const [scope, setScope] = useState<InstallScope>(cwd ? "project" : "global")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const installable = kind === "skills" || !!item.install

  async function install() {
    const gap = missingInput(inputs, values)
    if (gap) { setError(`${gap.name} is required.`); return }
    setBusy(true); setError("")
    try {
      const at = scope === "project" ? { cwd } : scope === "chat" ? { session } : {}
      if (kind === "mcp") await api.marketMcpInstall({ id: item.id, values: filledValues(values), scope, ...at })
      else await api.marketSkillInstall({ id: item.id, scope: scope === "global" ? "user" : scope, ...at })
      const who = scope === "chat" ? "this chat" : scope === "project" ? "this project's sessions" : "every session"
      Alert.alert("Installed", `${item.title} is ready for ${who}. New runs pick it up.`)
      onDone()
    } catch (e) {
      setError(userError(e, item.title))
    } finally {
      setBusy(false)
    }
  }

  const facts = [
    item.publisher ? `Published by ${item.publisher}` : "",
    item.version ? `Version ${item.version}` : "",
    kind === "mcp" && item.install ? (item.install === "remote" ? "Runs on the publisher's servers" : `Runs on this machine via ${item.install}`) : "",
    item.license ? `License: ${item.license}` : "",
  ].filter(Boolean)

  return (
    <ScrollView testID="market-detail" contentContainerStyle={{ padding: 16, paddingBottom: 60 }} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <Text style={{ color: t.text, fontSize: 15, lineHeight: 21 }}>{item.description}</Text>
      {facts.map(f => <Text key={f} style={[styles.hint, { marginTop: 6 }]}>{f}</Text>)}
      {item.repo ? (
        <TouchableOpacity testID="market-repo" onPress={() => Linking.openURL(item.repo)} style={{ marginTop: 8 }}>
          <Text style={{ color: t.accent }} numberOfLines={1}>{item.repo}</Text>
        </TouchableOpacity>
      ) : null}
      {!installable ? (
        <Text testID="market-not-installable" style={[styles.hint, { marginTop: 18, color: t.text }]}>
          This server ships only as a Docker image or bundle. Harman installs npm, PyPI and hosted servers; add it by hand from its repository.
        </Text>
      ) : (
        <>
          {inputs.map(i => (
            <View key={i.name}>
              <Text style={styles.label}>{i.name}{i.required ? " *" : ""}</Text>
              {i.description ? <Text style={[styles.hint, { marginTop: 0, marginBottom: 6 }]}>{i.description}</Text> : null}
              <TextInput testID={`market-input-${i.name}`} style={styles.input} value={values[i.name]} secureTextEntry={i.secret}
                onChangeText={v => setValues(prev => ({ ...prev, [i.name]: v }))} autoCapitalize="none" autoCorrect={false} />
            </View>
          ))}
          <Text style={styles.label}>Available to</Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            {offered.map(s => (
              <TouchableOpacity key={s} testID={`market-scope-${s}`} style={[styles.sheetPill, scope === s ? styles.sheetPillActive : null]} onPress={() => setScope(s)}>
                <Text style={[styles.sheetPillText, scope === s ? styles.sheetPillTextActive : null]}>{SCOPE_LABEL[s]}</Text>
              </TouchableOpacity>
            ))}
          </View>
          {error ? <Text testID="market-install-error" style={styles.error}>{error}</Text> : null}
          <TouchableOpacity testID="market-install" style={[styles.button, busy ? { opacity: 0.6 } : null]} disabled={busy} onPress={install}>
            {busy ? <ActivityIndicator color={t.onAccent} /> : <Text style={{ color: t.onAccent, fontWeight: "700", fontSize: 16 }}>Install</Text>}
          </TouchableOpacity>
          {kind === "mcp" ? <Text style={[styles.hint, { textAlign: "center" }]}>An MCP tool is code your agents can run. Install only what you trust.</Text> : null}
        </>
      )}
    </ScrollView>
  )
}
