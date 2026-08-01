import React, { useCallback, useEffect, useState } from "react"
import { ActivityIndicator, FlatList, RefreshControl, Text, TouchableOpacity, View } from "react-native"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api, type FileEntry } from "../api/client"
import { baseName, humanSize, joinPath, sortEntries } from "../lib/files"
import Icon from "../components/Icon"
import { useStyles } from "./styles"
import { useTheme } from "../lib/useTheme"

type Props = NativeStackScreenProps<RootStackParamList, "Files">

/**
 * Host-aware file browser. Read-only for now: tap a folder to descend, ".." to
 * go up. Sorting/formatting live in lib/files.ts so they're unit-tested.
 */
export default function FilesScreen({ route, navigation }: Props) {
  const styles = useStyles()
  const t = useTheme()
  const { host } = route.params
  const [path, setPath] = useState(route.params.path || "~")
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [parent, setParent] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  const load = useCallback(
    async (p: string) => {
      setError("")
      setLoading(true)
      try {
        const r = await api.fs(host, p)
        setEntries(sortEntries(r.entries || []))
        setPath(r.path)
        setParent(r.parent)
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setLoading(false)
      }
    },
    [host]
  )

  useEffect(() => {
    load(path)
  }, [load]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    navigation.setOptions({ title: baseName(path) })
  }, [navigation, path])

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <Text style={styles.fsPath} numberOfLines={1}>
        {path}
      </Text>
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      ) : (
        <FlatList
          testID="files-list"
          data={entries}
          keyExtractor={(e) => e.name}
          refreshControl={<RefreshControl refreshing={false} onRefresh={() => load(path)} />}
          ListHeaderComponent={
            <>
              {error ? <Text style={[styles.error, { paddingHorizontal: 16 }]}>{error}</Text> : null}
              {parent ? (
                <TouchableOpacity testID="files-up" style={styles.fsRow} onPress={() => load(parent)}>
                  <Icon name="up" size={18} color={t.textMuted} />
                  <Text style={styles.fsName}>..</Text>
                </TouchableOpacity>
              ) : null}
            </>
          }
          ListEmptyComponent={error ? null : <Text style={[styles.hint, { padding: 16 }]}>Empty folder.</Text>}
          renderItem={({ item }) => (
            <TouchableOpacity
              testID={`file-${item.name}`}
              style={styles.fsRow}
              disabled={!item.dir}
              onPress={() => item.dir && load(joinPath(path, item.name))}
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
