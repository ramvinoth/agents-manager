/**
 * MarketplaceSheet — browse and install from vetted sources: MCP tools from
 * the official MCP Registry, skills from anthropics/skills. Search → pick an
 * entry → read who publishes it, fill its inputs, choose where it applies →
 * Install. The server rebuilds the install from the source's own record, so
 * nothing typed here becomes a command. A server that signs in with OAuth
 * (a featured plugin like Microsoft 365) goes straight on to its sign-in.
 */
import React, { useCallback, useEffect, useRef, useState } from "react"
import { ActivityIndicator, Alert, FlatList, Linking, Modal, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native"
import { api, type MarketItem, type McpSignin } from "../api/client"
import { filledValues, installNote, missingInput, scopes, signinRedirectProblem, SCOPE_LABEL, type InstallScope, type MarketKind } from "../lib/marketplace"
import { userError } from "../lib/errors"
import { useTheme } from "../lib/useTheme"
import { useStyles } from "../lib/styles"
import Icon from "./Icon"

const SOURCE: Record<MarketKind, string> = {
  mcp: "Official MCP Registry · registry.modelcontextprotocol.io",
  skills: "Anthropic skills · github.com/anthropics/skills",
}

export default function MarketplaceSheet({ kind, cwd, session, agent, onClose, onInstalled }: {
  kind: MarketKind
  /** An agent's editor: installs onto that agent (every new chat from it gets a copy). */
  agent?: { id: number; name: string }
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
          <Install kind={kind} item={pick} cwd={cwd} session={session} agent={agent} onInstalled={onInstalled} onDone={onClose} />
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

function Install({ kind, item, cwd, session, agent, onInstalled, onDone }: {
  kind: MarketKind; item: MarketItem; cwd?: string; session?: string; agent?: { id: number; name: string }
  onInstalled: () => void; onDone: () => void
}) {
  const styles = useStyles()
  const t = useTheme()
  const inputs = item.inputs ?? []
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(inputs.map(i => [i.name, i.default || ""])))
  const offered = scopes(cwd, !!session, !!agent)
  // Default to the widest-but-scoped choice: this project when known, else all sessions.
  const [scope, setScope] = useState<InstallScope>(agent ? "agent" : cwd ? "project" : "global")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const installable = kind === "skills" || !!item.install
  // Servers still waiting on the owner's sign-in after the install, in order.
  const [signin, setSignin] = useState<string[]>([])

  async function install() {
    const gap = missingInput(inputs, values)
    if (gap) { setError(`${gap.name} is required.`); return }
    setBusy(true); setError("")
    try {
      const at = scope === "project" ? { cwd } : scope === "chat" ? { session } : scope === "agent" ? { agent: agent?.id } : {}
      if (kind === "mcp") {
        const res = await api.marketMcpInstall({ id: item.id, values: filledValues(values), scope, ...at })
        onInstalled()
        if (res.signin?.length) return setSignin(res.signin)
      } else {
        await api.marketSkillInstall({ id: item.id, scope: scope === "global" ? "user" : scope, ...at })
        onInstalled()
      }
      const who = scope === "agent" ? `every new ${agent?.name} chat` : scope === "chat" ? "this chat" : scope === "project" ? "this project's sessions" : "every session"
      Alert.alert("Installed", `${item.title} is ready for ${who}.${scope === "agent" ? "" : " New runs pick it up."}`)
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

  if (signin.length) {
    const at = scope === "project" ? { cwd } : scope === "chat" ? { session } : scope === "agent" ? { agent: agent?.id } : {}
    return <SignIn key={signin[0]} title={item.title} name={signin[0]} scope={scope} at={at}
      onDone={() => (signin.length > 1 ? setSignin(signin.slice(1)) : onDone())} />
  }

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
          This server ships only as a Docker image or bundle. Manager installs npm, PyPI and hosted servers; add it by hand from its repository.
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

/** One OAuth sign-in, driven on the server's machine. A phone can't reach that
 *  machine's localhost, so the last page fails to load — expected: the owner
 *  copies its address and pastes it here, and the server finishes the sign-in. */
function SignIn({ title, name, scope, at, onDone }: {
  title: string; name: string; scope: InstallScope; at: { cwd?: string; session?: string; agent?: number }; onDone: () => void
}) {
  const styles = useStyles()
  const t = useTheme()
  const [state, setState] = useState<McpSignin | null>(null)
  const [pasted, setPasted] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const live = useRef(true)
  const opened = useRef(false)
  useEffect(() => () => { live.current = false }, [])

  // Poll while a sign-in is open: it can also finish in a browser on that machine.
  const open = state?.stage === "starting" || state?.stage === "url"
  useEffect(() => {
    if (!open) return
    const h = setInterval(() => { api.mcpSignin().then(s => live.current && setState(s)).catch(() => {}) }, 2000)
    return () => clearInterval(h)
  }, [open])

  async function start() {
    setError(""); setBusy(true); opened.current = false
    try {
      setState(await api.mcpSigninStart({ name, scope, ...at }))
    } catch (e) { setError(userError(e, title, "start sign-in for")) }
    finally { setBusy(false) }
  }

  // The URL can arrive on a later poll; open the browser once it does.
  useEffect(() => {
    if (state?.url && !opened.current) { opened.current = true; Linking.openURL(state.url) }
  }, [state?.url])

  async function submit() {
    const problem = signinRedirectProblem(pasted)
    if (problem) return setError(problem)
    setError(""); setBusy(true)
    try { setState(await api.mcpSigninSubmit(pasted.trim())); setPasted("") }
    catch (e) { setError(userError(e, title, "finish sign-in for")) }
    finally { setBusy(false) }
  }

  function later() {
    if (open) api.mcpSigninCancel().catch(() => {})
    onDone()
  }

  if (state?.stage === "done") {
    return (
      <View testID="market-signin-done" style={{ padding: 16 }}>
        <Text style={{ color: t.text, fontSize: 17, fontWeight: "700" }}>Signed in to {title}.</Text>
        <Text style={[styles.hint, { marginTop: 6 }]}>Your agents can use it from their next run.</Text>
        <TouchableOpacity testID="market-signin-close" style={styles.button} onPress={onDone}>
          <Text style={{ color: t.onAccent, fontWeight: "700", fontSize: 16 }}>Done</Text>
        </TouchableOpacity>
      </View>
    )
  }

  return (
    <ScrollView testID="market-signin" contentContainerStyle={{ padding: 16, paddingBottom: 60 }} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <Text style={{ color: t.text, fontSize: 17, fontWeight: "700" }}>Installed. One step left: sign in.</Text>
      <Text style={[styles.hint, { marginTop: 6 }]}>
        Your agents can't reach {title} until you sign in once. The publisher's sign-in page opens in your browser; Manager never sees your password.
      </Text>
      <TouchableOpacity testID="market-signin-open" style={[styles.button, busy || (open && !state?.url) ? { opacity: 0.6 } : null]}
        disabled={busy || (open && !state?.url)} onPress={() => (state?.url ? Linking.openURL(state.url) : start())}>
        {busy || (open && !state?.url) ? <ActivityIndicator color={t.onAccent} /> : <Text style={{ color: t.onAccent, fontWeight: "700", fontSize: 16 }}>Open sign-in page</Text>}
      </TouchableOpacity>
      {state?.url ? (
        <>
          <Text style={[styles.hint, { marginTop: 14 }]}>
            After you sign in, the last page says it can't connect. That's expected: copy its whole address and paste it here.
          </Text>
          <TextInput testID="market-signin-paste" style={[styles.input, { marginTop: 8 }]} value={pasted} onChangeText={setPasted}
            placeholder="http://localhost:…/callback?code=…" placeholderTextColor={t.textMuted + "80"} autoCapitalize="none" autoCorrect={false} />
          <TouchableOpacity testID="market-signin-submit" style={[styles.button, busy || !pasted.trim() ? { opacity: 0.6 } : null]} disabled={busy || !pasted.trim()} onPress={submit}>
            <Text style={{ color: t.onAccent, fontWeight: "700", fontSize: 16 }}>Finish sign-in</Text>
          </TouchableOpacity>
        </>
      ) : null}
      {error || state?.stage === "error" ? <Text testID="market-signin-error" style={styles.error}>{error || state?.error}</Text> : null}
      {state?.stage === "error" ? (
        <TouchableOpacity testID="market-signin-retry" onPress={start} style={{ marginTop: 8 }}><Text style={{ color: t.accent }}>Try again</Text></TouchableOpacity>
      ) : null}
      <TouchableOpacity testID="market-signin-later" onPress={later} style={{ marginTop: 18, alignItems: "center" }}>
        <Text style={{ color: t.accent }}>Later</Text>
      </TouchableOpacity>
      <Text style={[styles.hint, { textAlign: "center" }]}>To sign in later, open {title} here again and press Install.</Text>
    </ScrollView>
  )
}
