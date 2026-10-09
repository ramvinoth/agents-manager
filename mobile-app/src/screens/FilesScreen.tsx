import React, { useCallback, useEffect, useRef, useState } from "react"
import { ActivityIndicator, Alert, Dimensions, FlatList, PanResponder, RefreshControl, Text, TouchableOpacity, View } from "react-native"
import * as DocumentPicker from "expo-document-picker"
import * as ImagePicker from "expo-image-picker"
import * as FileSystem from "expo-file-system"
import * as Sharing from "expo-sharing"
import type { NativeStackNavigationProp } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api, type Drive, type FileEntry } from "../api/client"
import {
  baseName, humanSize, joinPath, sortEntries,
  navInit, navVisit, navBack, navForward, navCurrent, navCanBack, navCanForward,
  type NavHistory,
} from "../lib/files"
import { HOST_LOCATION, START_PATH, describeLocation, fsScope, isLiveLocation, type Location } from "../lib/location"
import { useHost } from "../lib/useHost"
import { offerUndo } from "../lib/undo"
import { userError } from "../lib/errors"
import { useScreenHeader } from "../lib/useScreenHeader"
import LocationPicker, { LocationHeaderButton } from "../components/LocationPicker"
import Icon from "../components/Icon"
import { useStyles } from "../lib/styles"
import { useTheme } from "../lib/useTheme"
import { showActions } from "../lib/actionSheet"

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, keyof RootStackParamList> }

/**
 * Files (opened from the side menu): a location-aware file browser with upload / download / delete.
 * The files come from one of two places: the *current* host (shared state,
 * picked under Profile → Machine) or a cloud drive chosen here via the
 * top-right LocationPicker. Either change re-roots to the start folder. Tap a
 * folder to descend; tap a file to download+share; long-press any row for
 * delete. Back/forward history + on-screen nav buttons + edge-swipe navigation
 * (see navHistory in lib/files.ts).
 */
export default function FilesScreen({ navigation }: Props) {
  const styles = useStyles()
  const t = useTheme()
  const { host, label: hostLabel } = useHost()
  const [location, setLocation] = useState<Location>(HOST_LOCATION)
  const [drives, setDrives] = useState<Drive[]>([])
  const [locOpen, setLocOpen] = useState(false)
  const scope = fsScope(host, location)
  const [hist, setHist] = useState<NavHistory>(() => navInit(START_PATH))
  const path = navCurrent(hist)
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [parent, setParent] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  // Load a directory LISTING (no history change). Returns nothing; used by
  // history moves, host re-root, refresh, and post-mutation reloads.
  const fetchDir = useCallback(
    async (p: string, h: string, loc: Location) => {
      setError("")
      setLoading(true)
      try {
        const r = await api.fs(fsScope(h, loc), p)
        setEntries(sortEntries(r.entries || []))
        setParent(r.parent)
      } catch (e) {
        // A failed listing must not leave the previous place's files on
        // screen under the error — they'd read as this location's contents.
        setEntries([])
        setParent(undefined)
        setError(userError(e, "this folder"))
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

  // (Re)load whenever the current history entry or location changes.
  useEffect(() => {
    fetchDir(path, host, location)
  }, [fetchDir, path, host, location])

  // Re-root history whenever the place we look at changes. A host switch also
  // leaves any drive: the host is the app-wide choice, the drive was local to it.
  useEffect(() => {
    setLocation(HOST_LOCATION)
    setHist(navInit(START_PATH))
  }, [host])
  useEffect(() => {
    setHist(navInit(START_PATH))
  }, [location])
  useEffect(() => {
    api.drives().then((r) => setDrives(r.drives || [])).catch(() => {})
  }, [])
  // A drive removed elsewhere must not stay selected as a place.
  useEffect(() => {
    if (!isLiveLocation(location, drives)) setLocation(HOST_LOCATION)
  }, [drives, location])

  const canBack = navCanBack(hist)
  const canForward = navCanForward(hist)

  // EDGE-swipe history navigation, like the iOS Files app: inside a folder an
  // edge-drag right goes up the history (Back), an edge-drag from the right goes
  // Forward. iOS's own back-swipe would pop this screen instead, so it is off
  // while there is folder history to walk (see the gestureEnabled effect below)
  // and on at the start folder, where the same gesture leaves Files.
  // Handlers/history live in refs since the PanResponder is created once.
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
      await api.fsUpload(scope, path, uri, name, mime)
      await fetchDir(path, host, location)
    } catch (e) {
      setError(userError(e, "this file", "upload"))
    } finally {
      setBusy(false)
    }
  }

  function promptUpload() {
    showActions("Upload to " + baseName(path), [
      { text: "Photo", onPress: doUploadPhoto },
      { text: "File", onPress: doUploadFile },
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
      setError("")
      try {
        const r = await api.fsMkdir(scope, { path, name: n })
        if (r?.error) setError(r.error)
        else await fetchDir(path, host, location)
      } catch (e) {
        setError(userError(e, "the folder", "create"))
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
      const dest = FileSystem.cacheDirectory + encodeURIComponent(item.name)
      const status = await api.fsDownload(scope, full, dest)
      if (status >= 400) {
        // The body on disk is the server's JSON error, not the file: surface
        // its message and don't leave it in the cache under the file's name.
        const body = await FileSystem.readAsStringAsync(dest).catch(() => "")
        await FileSystem.deleteAsync(dest, { idempotent: true }).catch(() => {})
        let msg = `Download failed (HTTP ${status})`
        try { msg = JSON.parse(body).error || msg } catch {}
        throw new Error(msg)
      }
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(dest)
    } catch (e) {
      setError(userError(e, "this file", "download"))
    } finally {
      setBusy(false)
    }
  }

  // Instant with Undo (lib/undo.ts): the row goes now, the trash move runs when
  // the window closes. Reload after either so the list is the server's truth.
  const here = useRef("")
  here.current = JSON.stringify([scope, path])
  function remove(item: FileEntry) {
    const at = { path, host, location, scope }
    const key = here.current
    // Only re-read if the owner is still looking at that folder.
    const refresh = () => { if (here.current === key) return fetchDir(at.path, at.host, at.location) }
    setEntries((all) => all.filter((e) => e.name !== item.name))
    offerUndo({
      label: `${item.name} moved to trash`,
      undo: () => { refresh() },
      commit: async () => {
        try {
          const r = await api.fsDelete(at.scope, { path: joinPath(at.path, item.name) })
          if (r?.error) setError(r.error)
        } catch (e) {
          setError(userError(e, "this item", "delete"))
        }
        await refresh()
      },
    })
  }

  // The header carries only the location chip. The terminal lives on Chats:
  // it opens a home-directory shell, not this folder, so a second entry point
  // here only duplicated it. New-folder/upload act on the current folder, so
  // they sit in the folder toolbar below.
  const onDrive = location !== HOST_LOCATION
  useEffect(() => { navigation.setOptions({ gestureEnabled: !canBack }) }, [navigation, canBack])

  useScreenHeader(navigation, () => ({
    title: "Files",
    headerLeft: undefined,
    headerRight: () => (
      <LocationHeaderButton value={location} drives={drives} hostLabel={hostLabel} onPress={() => setLocOpen(true)} />
    ),
  }), [location, drives, hostLabel])

  return (
    <View style={styles.page} {...pan.panHandlers}>
      {/* Nav toolbar: Back / Forward / Up mirror the edge-swipe gestures so history
          is reachable without swiping. */}
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
          {onDrive ? `${describeLocation(location, drives, hostLabel)}: ${path}` : path}
        </Text>
        <TouchableOpacity
          testID="files-newfolder"
          onPress={promptNewFolder}
          hitSlop={8}
          style={{ padding: 6 }}
        >
          <Icon name="folderPlus" size={22} color={t.accent} />
        </TouchableOpacity>
        <TouchableOpacity
          testID="files-upload"
          onPress={promptUpload}
          hitSlop={8}
          style={{ padding: 6 }}
        >
          <Icon name="upload" size={22} color={t.accent} />
        </TouchableOpacity>
      </View>
      <LocationPicker
        visible={locOpen}
        onClose={() => setLocOpen(false)}
        value={location}
        hostLabel={hostLabel}
        navigation={navigation}
        onChange={(loc, all) => { setDrives(all); setLocation(loc) }}
      />
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
          refreshControl={<RefreshControl refreshing={false} onRefresh={() => fetchDir(path, host, location)} />}
          ListHeaderComponent={
            <>
              {error ? (
                <View style={{ paddingHorizontal: 16 }}>
                  <Text testID="filestab-error" style={styles.error}>{error}</Text>
                  <TouchableOpacity testID="filestab-retry" accessibilityRole="button" onPress={() => fetchDir(path, host, location)} style={{ minHeight: 44, justifyContent: "center" }}>
                    <Text style={{ color: t.accent, fontSize: 16 }}>Try again</Text>
                  </TouchableOpacity>
                </View>
              ) : null}
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
              onLongPress={() => remove(item)}
              delayLongPress={350}
            >
              <Icon name={item.dir ? "folder" : "file"} size={18} color={item.dir ? t.warning : t.textMuted} />
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
