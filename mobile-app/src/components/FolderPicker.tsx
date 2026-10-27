/**
 * FolderPicker — choose a folder by browsing, the way a system "Open folder"
 * dialog works: tap a folder to go into it, Up to go back out, and "Use this
 * folder" picks the one you are in. Only folders are listed. It browses the
 * machine the chat will run on (this machine or an SSH host), never a cloud
 * drive — an agent cannot work inside a drive.
 *
 * A bottom sheet: the list scrolls while Cancel / Use this folder stay pinned
 * below it. The sheet's Modal drops its content once shut, so each opening
 * starts at `start` (the chat's current folder, or home).
 */
import React, { useEffect, useState } from "react"
import { ActivityIndicator, Alert, FlatList, Text, TouchableOpacity, View } from "react-native"
import { api, type FileEntry } from "../api/client"
import { fsScope, HOST_LOCATION } from "../lib/location"
import { joinPath, sortEntries } from "../lib/files"
import { userError } from "../lib/errors"
import { useStyles } from "../lib/styles"
import { useTheme } from "../lib/useTheme"
import Icon from "./Icon"
import SheetModal from "./SheetModal"

type Props = { host: string; start: string; onPick: (path: string) => void; onClose: () => void }

export default function FolderPicker({ visible, ...body }: Props & { visible: boolean }) {
  return (
    <SheetModal visible={visible} onClose={body.onClose}>
      <Browser {...body} />
    </SheetModal>
  )
}

function Browser({ host, start, onPick, onClose }: Props) {
  const styles = useStyles()
  const t = useTheme()
  const scope = fsScope(host, HOST_LOCATION)
  const [path, setPath] = useState(start || "~")
  // The server's resolved form of `path` ("~" → "/Users/ram"): what gets picked.
  const [resolved, setResolved] = useState("")
  const [parent, setParent] = useState<string | undefined>()
  const [folders, setFolders] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let alive = true
    setLoading(true); setError("")
    api.fs(scope, path).then((r) => {
      if (!alive) return
      setResolved(r.path); setParent(r.parent)
      setFolders(sortEntries((r.entries || []).filter((e) => e.dir)))
    }).catch((e) => {
      if (!alive) return
      // Nothing from the previous folder may stay on screen under this error,
      // and nothing can be picked until a folder actually lists.
      setResolved(""); setParent(undefined); setFolders([])
      setError(userError(e, "this folder"))
    }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
    // scope is derived from host; keying on host keeps the effect stable.
  }, [host, path, reload]) // eslint-disable-line react-hooks/exhaustive-deps

  // iOS has Alert.prompt; elsewhere the control is simply absent.
  const prompt = (Alert as unknown as { prompt?: (t: string, m: string | undefined, cb: (v: string) => void) => void }).prompt
  const newFolder = () => prompt?.("New folder", `Inside ${resolved}`, async (raw) => {
    const name = (raw || "").trim()
    if (!name) return
    try {
      const r = await api.fsMkdir(scope, { path: resolved, name })
      if (r?.error) { setError(r.error); return }
      setPath(joinPath(resolved, name))
    } catch (e) {
      setError(userError(e, "the folder", "create"))
    }
  })

  return (
    <View style={{ flexShrink: 1 }}>
      <View style={styles.sheetGrabber} />
      <Text style={styles.sheetTitle}>Choose a folder</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingTop: 6 }}>
        <TouchableOpacity testID="folder-up" accessibilityLabel="Up one folder" disabled={!parent || loading}
          onPress={() => parent && setPath(parent)} hitSlop={8} style={{ padding: 6, opacity: parent ? 1 : 0.3 }}>
          <Icon name="chevronLeft" size={20} color={t.accent} />
        </TouchableOpacity>
        <Text testID="folder-path" style={{ flex: 1, color: t.textMuted, fontSize: 13 }} numberOfLines={1} ellipsizeMode="head">
          {resolved || path}
        </Text>
        {prompt && resolved ? (
          <TouchableOpacity testID="folder-new" accessibilityLabel="New folder" onPress={newFolder} hitSlop={8} style={{ padding: 6 }}>
            <Icon name="folderPlus" size={20} color={t.accent} />
          </TouchableOpacity>
        ) : null}
      </View>
      {error ? (
        <View style={{ paddingHorizontal: 18, paddingVertical: 10, gap: 8 }}>
          <Text testID="folder-error" style={styles.error}>{error}</Text>
          <View style={{ flexDirection: "row", gap: 16 }}>
            <TouchableOpacity testID="folder-retry" onPress={() => setReload((n) => n + 1)}><Text style={{ color: t.accent, fontWeight: "600" }}>Try again</Text></TouchableOpacity>
            {path !== "~" ? <TouchableOpacity testID="folder-home" onPress={() => setPath("~")}><Text style={{ color: t.accent, fontWeight: "600" }}>Go to home folder</Text></TouchableOpacity> : null}
          </View>
        </View>
      ) : null}
      <FlatList
        testID="folder-list"
        style={{ flexShrink: 1, minHeight: 240 }}
        data={folders}
        keyExtractor={(e) => e.name}
        ListEmptyComponent={loading ? <ActivityIndicator style={{ margin: 24 }} /> : error ? null
          : <Text style={[styles.hint, { padding: 18 }]}>No folders inside. Use this folder, or make a new one.</Text>}
        renderItem={({ item }) => (
          <TouchableOpacity testID={`folder-${item.name}`} style={styles.fsRow} onPress={() => setPath(joinPath(resolved, item.name))}>
            <Icon name="folder" size={18} color={t.warning} />
            <Text style={styles.fsName} numberOfLines={1}>{item.name}</Text>
            <Icon name="chevronRight" size={14} color={t.textMuted} />
          </TouchableOpacity>
        )}
      />
      <View style={{ marginHorizontal: 18, marginTop: 8, flexDirection: "row", gap: 8 }}>
        <TouchableOpacity testID="folder-cancel" style={[styles.ssAddBtn, { flex: 1, backgroundColor: t.chipBg }]} onPress={onClose}>
          <Text style={[styles.ssAddBtnText, { color: t.text }]}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity testID="folder-use" style={[styles.ssAddBtn, { flex: 1, opacity: resolved && !loading ? 1 : 0.5 }]}
          disabled={!resolved || loading} onPress={() => onPick(resolved)}>
          <Text style={styles.ssAddBtnText}>Use this folder</Text>
        </TouchableOpacity>
      </View>
    </View>
  )
}
