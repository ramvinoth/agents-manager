import React, { useEffect, useState } from "react"
import { Alert, Text, TouchableOpacity, View } from "react-native"
import type { NativeStackNavigationProp } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import {
  activeServerId,
  removeServer,
  servers,
  subscribeServer,
  switchServer,
  token,
  type ServerEntry,
} from "../state/config"
import { useTheme } from "../lib/useTheme"
import Icon from "./Icon"
import SheetModal from "./SheetModal"
import { useStyles } from "../screens/styles"

/**
 * Bottom-sheet server picker — the Profile "Server" row's affordance. Mirrors
 * HostPicker's chrome (scrim + grabber + rows). Picking a server switches the
 * active backend (state/config switchServer) and re-roots the navigation stack
 * to Home or Login depending on whether that server already has a token.
 *
 * Switching backends is heavier than switching a host: the whole authenticated
 * stack belongs to one server, so we reset() to the appropriate root rather than
 * navigate() — otherwise the previous server's Chats/Files screens would linger
 * with stale data until the next focus.
 */
export default function ServerPicker({
  visible,
  onClose,
  navigation,
}: {
  visible: boolean
  onClose: () => void
  navigation: NativeStackNavigationProp<RootStackParamList, keyof RootStackParamList>
}) {
  const [list, setList] = useState<ServerEntry[]>(servers())
  const [active, setActive] = useState(activeServerId())
  const styles = useStyles()
  const t = useTheme()

  // Re-read from config whenever the sheet opens or the server state changes
  // (add/remove/switch elsewhere), so the list and checkmark stay in sync.
  useEffect(() => {
    const sync = () => {
      setList(servers())
      setActive(activeServerId())
    }
    sync()
    return subscribeServer(sync)
  }, [visible])

  async function pick(id: string) {
    if (id === activeServerId()) return onClose()
    await switchServer(id)
    onClose()
    // Re-root: a server we already have a token for goes straight to Home; a
    // tokenless one needs sign-in first.
    navigation.reset({ index: 0, routes: [{ name: token() ? "Home" : "Login" }] })
  }

  function confirmRemove(entry: ServerEntry) {
    Alert.alert(
      "Remove server",
      `Remove ${entry.name || entry.url}? Its saved sign-in on this device is forgotten.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Remove", style: "destructive", onPress: () => removeServer(entry.id) },
      ]
    )
  }

  return (
    <SheetModal visible={visible} onClose={onClose}>
      <View style={styles.sheetGrabber} />
      <Text style={styles.actionSheetTitle}>Switch server</Text>

      {list.map((s) => {
        const on = active === s.id
        return (
          <View key={s.id} style={[styles.actionRow, { flexDirection: "row", alignItems: "center" }]}>
            <TouchableOpacity
              testID={`serverpick-${s.id}`}
              style={{ flex: 1, flexDirection: "row", alignItems: "center" }}
              onPress={() => pick(s.id)}
            >
              <Icon name={on ? "serverFilled" : "server"} size={18} color={on ? t.accent : t.textMuted} />
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={[styles.actionText, { color: on ? t.accent : t.text }]} numberOfLines={1}>
                  {s.name || s.url}
                </Text>
                {s.name ? (
                  <Text style={styles.rowSub} numberOfLines={1}>
                    {s.url}
                  </Text>
                ) : null}
              </View>
              {on ? <Icon name="check" size={16} color={t.accent} /> : null}
            </TouchableOpacity>
            {/* The active server can't be removed — that would leave the app with
                no backend to talk to while it's showing that server's screens. */}
            {!on ? (
              <TouchableOpacity
                testID={`serverpick-remove-${s.id}`}
                onPress={() => confirmRemove(s)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                style={{ marginLeft: 12 }}
              >
                <Icon name="trash" size={16} color={t.textMuted} />
              </TouchableOpacity>
            ) : null}
          </View>
        )
      })}

      <TouchableOpacity
        testID="serverpick-add"
        style={[styles.actionRow, { flexDirection: "row", alignItems: "center" }]}
        onPress={() => {
          onClose()
          navigation.navigate("Server", { mode: "add" })
        }}
      >
        <Icon name="add" size={18} color={t.accent} />
        <Text style={[styles.actionText, { color: t.accent, marginLeft: 12 }]}>Add server</Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.sheetCancel} onPress={onClose}>
        <Text style={styles.sheetCancelText}>Cancel</Text>
      </TouchableOpacity>
    </SheetModal>
  )
}
