import React, { useEffect, useState } from "react"
import { Text, TouchableOpacity, View } from "react-native"
import type { NativeStackNavigationProp } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api, type Host } from "../api/client"
import { currentHost, setCurrentHost } from "../state/config"
import { useTheme } from "../lib/useTheme"
import Icon from "./Icon"
import SheetModal from "./SheetModal"
import { useStyles } from "../screens/styles"

// The implicit "this machine" host. Shared so screens agree on the sentinel.
export const LOCAL: Host = { id: "local", label: "This machine", host: "localhost", user: "", port: 0, auth: "password", keyFile: "" }

/**
 * Bottom-sheet host picker — the top-left header affordance that replaces the
 * old Hosts tab. Mirrors ChatActions' sheet chrome (scrim + grabber + rows).
 * Picking a host updates shared state (currentHost) so every host-scoped screen
 * — Chats, Files, Projects — re-roots to it via subscribeChatFilter.
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

/**
 * The header-left button that opens the picker: a small server icon + the
 * current host's label. Shared by Chats, Files, and Projects so the host can be
 * switched from any host-scoped screen. Renders its own picker Modal.
 */
export function HostHeaderButton({
  navigation,
}: {
  navigation: NativeStackNavigationProp<RootStackParamList, keyof RootStackParamList>
}) {
  const [open, setOpen] = useState(false)
  const [hostId, setHostId] = useState(currentHost())
  const [label, setLabel] = useState<string>("This machine")
  const styles = useStyles()
  const t = useTheme()

  // Keep the label in sync with the active host: resolve its friendly name from
  // the host list (falls back to the id) and re-resolve when it changes.
  useEffect(() => {
    let cancelled = false
    const resolve = () => {
      const id = currentHost()
      setHostId(id)
      if (id === "local") return setLabel("This machine")
      api
        .hosts()
        .then((r) => {
          if (cancelled) return
          setLabel(r.find((h) => h.id === id)?.label || id)
        })
        .catch(() => !cancelled && setLabel(id))
    }
    resolve()
    // Re-resolve when the sheet closes (host may have changed).
    return () => {
      cancelled = true
    }
  }, [open])

  return (
    <>
      <TouchableOpacity
        testID="host-header-button"
        accessibilityLabel="switch-host"
        onPress={() => setOpen(true)}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        style={{ flexDirection: "row", alignItems: "center", maxWidth: 160, marginLeft: 4 }}
      >
        <Icon name={hostId === "local" ? "serverFilled" : "server"} size={18} color={t.accent} />
        <Text style={{ color: t.accent, fontWeight: "600", marginLeft: 5, flexShrink: 1 }} numberOfLines={1} ellipsizeMode="tail">
          {label}
        </Text>
      </TouchableOpacity>
      <HostPicker visible={open} onClose={() => setOpen(false)} navigation={navigation} />
    </>
  )
}
