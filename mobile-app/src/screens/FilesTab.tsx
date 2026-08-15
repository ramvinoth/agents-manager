import React, { useCallback, useEffect, useRef, useState } from "react"
import { ActivityIndicator, Alert, Dimensions, FlatList, PanResponder, RefreshControl, Text, TouchableOpacity, View } from "react-native"
import * as DocumentPicker from "expo-document-picker"
import * as ImagePicker from "expo-image-picker"
import * as FileSystem from "expo-file-system"
import * as Sharing from "expo-sharing"
import { useFocusEffect } from "@react-navigation/native"
import type { NativeStackNavigationProp } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api, type FileEntry } from "../api/client"
import {
  baseName, humanSize, joinPath, sortEntries,
  navInit, navVisit, navBack, navForward, navCurrent, navCanBack, navCanForward,
  type NavHistory,
} from "../lib/files"
import { currentHost, subscribeChatFilter } from "../state/config"
import { HostHeaderButton } from "../components/HostPicker"
import Icon from "../components/Icon"
import { useStyles } from "./styles"
import { useTheme } from "../lib/useTheme"

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, keyof RootStackParamList> }

/**
 * Files tab: a host-aware filesystem browser with upload / download / delete.
 * Reads the *current* host from shared state and re-roots to ~ when it changes —
 * so the top-left HostPicker drives it. Tap a folder to descend; tap a file to
 * download+share; long-press any row for delete. Back/forward history + on-screen
 * nav buttons + edge-swipe navigation (see navHistory in lib/files.ts).
 */
export default function FilesTab({ navigation }: Props) {
  const styles = useStyles()
  const t = useTheme()
  const [host, setHost] = useState(currentHost())
  const [hostLabel, setHostLabel] = useState("This machine")
  const [hist, setHist] = useState<NavHistory>(() => navInit("~"))
  const path = navCurrent(hist)
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [parent, setParent] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  // Load a directory LISTING (no history change). Returns nothing; used by
  // history moves, host re-root, refresh, and post-mutation reloads.
  const fetchDir = useCallback(
    async (p: string, h: string) => {
      setError("")
      setLoading(true)
      try {
        const r = await api.fs(h, p)
        setEntries(sortEntries(r.entries || []))
        setParent(r.parent)
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setLoading(false)
      }
    },
    []
  )

  // Navigate to a NEW path (descend / up): push onto history.
  const go = useCallback((p: string) => setHist((h) => navVisit(h, p)), [])
  const goBack = useCallback(() => setHist((h) => navBack(h)), [])
  const goForward = useCallback(() => setHist((h) => navForward(h)), [])

  // (Re)load whenever the current history entry or host changes.
  useEffect(() => {
    fetchDir(path, host)
  }, [fetchDir, path, host])

  // Re-root history to ~ whenever the active host changes.
  useEffect(() => {
    setHist(navInit("~"))
  }, [host])

  const canBack = navCanBack(hist)
  const canForward = navCanForward(hist)

  // EDGE-swipe history navigation that coexists with the tab pager. The Files tab
  // lives inside a swipeable material-top-tabs pager that claims horizontal drags,
  // so a center swipe changes TABS (by design). We only claim a gesture that STARTS
  // near the screen edge — an edge-drag right = Back, edge-drag left = Forward —
  // which the pager leaves alone. Center/full swipes fall through to the pager
  // unchanged. Handlers/history live in refs since the PanResponder is created once.
  const EDGE = 32 // px from a screen edge where a history-swipe may start
  const TRIGGER = 56 // px of travel before it fires
  const screenW = Dimensions.get("window").width
  const backRef = useRef(goBack)
  const fwdRef = useRef(goForward)
  const canBackRef = useRef(canBack)
  const canFwdRef = useRef(canForward)
  backRef.current = goBack
  fwdRef.current = goForward
  canBackRef.current = canBack
  canFwdRef.current = canForward

  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (e, g) => {
        const x0 = e.nativeEvent.pageX - g.dx // touch start x
        const horizontal = Math.abs(g.dx) > 14 && Math.abs(g.dx) > Math.abs(g.dy) * 1.6
        if (!horizontal) return false
        // Left edge → allow a rightward (Back) drag; right edge → leftward (Forward).
        if (x0 <= EDGE && g.dx > 0 && canBackRef.current) return true
        if (x0 >= screenW - EDGE && g.dx < 0 && canFwdRef.current) return true
        return false
      },
      onPanResponderRelease: (_e, g) => {
        if (g.dx > TRIGGER && canBackRef.current) backRef.current()
        else if (g.dx < -TRIGGER && canFwdRef.current) fwdRef.current()
      },
    })
  ).current

  // Resolve the current host's friendly label (for the Terminal header title),
  // mirroring HostHeaderButton. Local is a fixed name; SSH hosts come from the list.
  useEffect(() => {
    let cancelled = false
    if (host === "local") {
      setHostLabel("This machine")
      return
    }
    api
      .hosts()
      .then((r) => !cancelled && setHostLabel(r.find((h) => h.id === host)?.label || host))
      .catch(() => !cancelled && setHostLabel(host))
    return () => {
      cancelled = true
    }
  }, [host])

  useEffect(() => {
    return subscribeChatFilter(() => {
      const h = currentHost()
      setHost((prev) => (prev === h ? prev : h))
    })
  }, [])

  async function doUploadPhoto() {
    const res = await ImagePicker.launchImageLibraryAsync({ quality: 1 })
    if (res.canceled || !res.assets?.length) return
    const a = res.assets[0]
    await runUpload(a.uri, a.fileName || `photo-${Date.now()}.jpg`, a.mimeType)
  }

  async function doUploadFile() {
    const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true })
    if (res.canceled || !res.assets?.length) return
    const a = res.assets[0]
    await runUpload(a.uri, a.name, a.mimeType)
  }

  async function runUpload(uri: string, name: string, mime?: string) {
    setBusy(true)
    setError("")
    try {
      await api.fsUpload(host, path, uri, name, mime)
      await fetchDir(path, host)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  function promptUpload() {
    Alert.alert("Upload to " + baseName(path), undefined, [
      { text: "Photo", onPress: doUploadPhoto },
      { text: "File", onPress: doUploadFile },
      { text: "Cancel", style: "cancel" },
    ])
  }

  function promptNewFolder() {
    // iOS supports Alert.prompt; guard for platforms that don't.
    const AlertAny = Alert as unknown as {
      prompt?: (t: string, m: string | undefined, cb: (v: string) => void) => void
    }
    if (!AlertAny.prompt) return
    AlertAny.prompt("New folder", undefined, async (name: string) => {
      const n = (name || "").trim()
      if (!n) return
      setBusy(true)
      try {
        const r = await api.fsMkdir({ path, name: n, host })
        if (r?.error) setError(r.error)
        else await fetchDir(path, host)
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setBusy(false)
      }
    })
  }

  async function downloadShare(item: FileEntry) {
    setBusy(true)
    setError("")
    try {
      const full = joinPath(path, item.name)
      const { url, headers } = api.fsDownloadUrl(host, full)
      const dest = FileSystem.cacheDirectory + encodeURIComponent(item.name)
      const r = await FileSystem.downloadAsync(url, dest, { headers })
      if (r.status >= 400) throw new Error(`HTTP ${r.status}`)
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(r.uri)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  function confirmDelete(item: FileEntry) {
    Alert.alert("Delete " + item.name + "?", "It will be moved to the server's trash.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          setBusy(true)
          try {
            const r = await api.fsDelete({ path: joinPath(path, item.name), host })
            if (r?.error) setError(r.error)
            else await fetchDir(path, host)
          } catch (e) {
            setError((e as Error).message)
          } finally {
            setBusy(false)
          }
        },
      },
    ])
  }

  // Re-assert this tab's header on FOCUS: swipeable tabs share one parent-stack
  // header and stay mounted, so setting it only on mount lets a sibling tab's
  // header linger. Files owns the new-folder + upload actions.
  useFocusEffect(
    useCallback(() => {
      navigation.setOptions({
        headerLeft: () => <HostHeaderButton navigation={navigation} />,
        headerRight: () => (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginRight: 4 }}>
            <TouchableOpacity
              testID="files-terminal"
              accessibilityLabel="open-terminal"
              onPress={() => navigation.navigate("Terminal", { host, label: hostLabel })}
              hitSlop={8}
              style={{ width: 32, height: 32, alignItems: "center", justifyContent: "center" }}
            >
              <Icon name="terminal" size={21} color={t.accent} />
            </TouchableOpacity>
            <TouchableOpacity
              testID="files-newfolder"
              onPress={promptNewFolder}
              hitSlop={8}
              style={{ width: 32, height: 32, alignItems: "center", justifyContent: "center" }}
            >
              <Icon name="folderPlus" size={22} color={t.accent} />
            </TouchableOpacity>
            <TouchableOpacity
              testID="files-upload"
              onPress={promptUpload}
              hitSlop={8}
              style={{ width: 32, height: 32, alignItems: "center", justifyContent: "center" }}
            >
              <Icon name="upload" size={22} color={t.accent} />
            </TouchableOpacity>
          </View>
        ),
      })
    }, [navigation, t, path, host, hostLabel]) // eslint-disable-line react-hooks/exhaustive-deps
  )

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }} {...pan.panHandlers}>
      {/* Nav toolbar: Back / Forward / Up mirror the edge-swipe gestures so history
          is reachable without swiping (and regardless of the tab pager). */}
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 6, paddingTop: 4, gap: 2 }}>
        <TouchableOpacity testID="filestab-back" disabled={!canBack} onPress={goBack} hitSlop={6} style={{ padding: 6, opacity: canBack ? 1 : 0.3 }}>
          <Icon name="chevronLeft" size={22} color={t.text} />
        </TouchableOpacity>
        <TouchableOpacity testID="filestab-forward" disabled={!canForward} onPress={goForward} hitSlop={6} style={{ padding: 6, opacity: canForward ? 1 : 0.3 }}>
          <Icon name="chevronRight" size={22} color={t.text} />
        </TouchableOpacity>
        <TouchableOpacity testID="filestab-up-btn" disabled={!parent} onPress={() => parent && go(parent)} hitSlop={6} style={{ padding: 6, opacity: parent ? 1 : 0.3 }}>
          <Icon name="up" size={20} color={t.text} />
        </TouchableOpacity>
        <Text style={[styles.fsPath, { flex: 1, marginLeft: 4 }]} numberOfLines={1}>
          {path}
        </Text>
      </View>
      {busy ? (
        <View style={styles.fsBusy}>
          <ActivityIndicator size="small" />
        </View>
      ) : null}
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      ) : (
        <FlatList
          testID="filestab-list"
          data={entries}
          keyExtractor={(e) => e.name}
          refreshControl={<RefreshControl refreshing={false} onRefresh={() => fetchDir(path, host)} />}
          ListHeaderComponent={
            <>
              {error ? <Text style={[styles.error, { paddingHorizontal: 16 }]}>{error}</Text> : null}
              {parent ? (
                <TouchableOpacity testID="filestab-up" style={styles.fsRow} onPress={() => parent && go(parent)}>
                  <Icon name="up" size={18} color={t.textMuted} />
                  <Text style={styles.fsName}>..</Text>
                </TouchableOpacity>
              ) : null}
            </>
          }
          ListEmptyComponent={error ? null : <Text style={[styles.hint, { padding: 16 }]}>Empty folder.</Text>}
          renderItem={({ item }) => (
            <TouchableOpacity
              testID={`filestab-${item.name}`}
              style={styles.fsRow}
              onPress={() => (item.dir ? go(joinPath(path, item.name)) : downloadShare(item))}
              onLongPress={() => confirmDelete(item)}
              delayLongPress={350}
            >
              <Icon name={item.dir ? "folder" : "file"} size={18} color={item.dir ? "#d6a44e" : t.textMuted} />
              <Text style={[styles.fsName, !item.dir ? styles.fsFile : null]} numberOfLines={1}>
                {item.name}
              </Text>
              {!item.dir ? <Text style={styles.fsSize}>{humanSize(item.size)}</Text> : null}
            </TouchableOpacity>
          )}
        />
      )}
    </View>
  )
}
