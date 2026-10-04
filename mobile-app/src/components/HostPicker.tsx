import React, { useEffect, useState } from "react"
import { Text, TouchableOpacity, View } from "react-native"
import type { NativeStackNavigationProp } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api, type Host } from "../api/client"
import { currentHost, setCurrentHost } from "../state/config"
import { useTheme } from "../lib/useTheme"
import Icon from "./Icon"
import { LOCAL_LABEL } from "../lib/useHost"
import SheetModal from "./SheetModal"
import { useStyles } from "../screens/styles"

// The implicit "this machine" host. Shared so screens agree on the sentinel.
const LOCAL: Host = { id: "local", label: LOCAL_LABEL, host: "localhost", user: "", port: 0, auth: "password", keyFile: "" }

/**
 * Bottom-sheet machine picker, opened from Profile's "Machine" row. Mirrors
 * ChatActions' sheet chrome (scrim + grabber + rows). Picking a host updates
 * shared state (setCurrentHost → subscribeHost) so every host-scoped screen —
 * Chats, Files — re-roots to it.
 */
export default function HostPicker({
  visible,
  onClose,
  navigation,
}: {
  visible: boolean
  onClose: () => void
  navigation: NativeStackNavigationProp<RootStackParamList, keyof RootStackParamList>
}) {
  const [hosts, setHosts] = useState<Host[]>([LOCAL])
  const [active, setActive] = useState(currentHost())
  const styles = useStyles()
  const t = useTheme()

  useEffect(() => {
    if (!visible) return
    setActive(currentHost())
    api
      .hosts()
      .then((r) => setHosts([LOCAL, ...r]))
      .catch(() => setHosts([LOCAL]))
  }, [visible])

  function pick(id: string) {
    setCurrentHost(id) // notifies host-scoped screens via the shared filter pub-sub
    setActive(id)
    onClose()
  }

  return (
    <SheetModal visible={visible} onClose={onClose}>
      <View style={styles.sheetGrabber} />
      <Text style={styles.actionSheetTitle}>Switch host</Text>

      {hosts.map((h) => {
        const on = active === h.id
        return (
          <TouchableOpacity
            key={h.id}
            testID={`hostpick-${h.id}`}
            style={[styles.actionRow, { flexDirection: "row", alignItems: "center" }]}
            onPress={() => pick(h.id)}
          >
            <Icon name={on ? "serverFilled" : "server"} size={18} color={on ? t.accent : t.textMuted} />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={[styles.actionText, { color: on ? t.accent : t.text }]} numberOfLines={1}>
                {h.label}
              </Text>
              {h.id !== "local" ? (
                <Text style={styles.rowSub} numberOfLines={1}>
                  {h.user}@{h.host}:{h.port}
                </Text>
              ) : null}
            </View>
            {on ? <Icon name="check" size={16} color={t.accent} /> : null}
          </TouchableOpacity>
        )
      })}

      <TouchableOpacity
        testID="hostpick-add"
        style={[styles.actionRow, { flexDirection: "row", alignItems: "center" }]}
        onPress={() => {
          onClose()
          navigation.navigate("HostEdit", undefined)
        }}
      >
        <Icon name="add" size={18} color={t.accent} />
        <Text style={[styles.actionText, { color: t.accent, marginLeft: 12 }]}>Add SSH host</Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.sheetCancel} onPress={onClose}>
        <Text style={styles.sheetCancelText}>Cancel</Text>
      </TouchableOpacity>
    </SheetModal>
  )
}
