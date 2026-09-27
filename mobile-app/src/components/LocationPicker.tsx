import React, { useEffect, useRef, useState } from "react"
import { ActivityIndicator, Alert, Linking, Text, TouchableOpacity, View } from "react-native"
import type { NativeStackNavigationProp } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api, type Drive } from "../api/client"
import { HOST_LOCATION, describeLocation, vendorLabel, type Location } from "../lib/location"
import { useTheme } from "../lib/useTheme"
import Icon from "./Icon"
import SheetModal from "./SheetModal"
import { useStyles } from "../screens/styles"

/**
 * LocationPicker — the Files tab's "where am I looking" sheet. One list: the
 * current host (the app-wide choice from the header, shown by its label),
 * every cloud drive, and one "Add <vendor>" row per vendor the server can
 * connect. Picking an unauthorized drive (never connected, or its token was
 * revoked) runs the consent flow first: the server hands back a URL we open
 * in the system browser and a handle we poll; the browser lands on the
 * server's callback page and the poll flips to `authorized`. A vendor with no
 * client on record cannot start consent — the server refuses with guidance —
 * and that refusal routes to the Integrations screen where the client is
 * entered; the same screen is one row away for later edits.
 *
 * Owns only the picker's transient state (the drive list, the in-flight
 * connect). The selected location belongs to the Files tab, which threads it
 * into every file call.
 */
export default function LocationPicker({
  visible,
  onClose,
  value,
  hostLabel,
  onChange,
  navigation,
}: {
  visible: boolean
  onClose: () => void
  value: Location
  hostLabel: string
  onChange: (loc: Location, drives: Drive[]) => void
  navigation: NativeStackNavigationProp<RootStackParamList, keyof RootStackParamList>
}) {
  const styles = useStyles()
  const t = useTheme()
  const [drives, setDrives] = useState<Drive[]>([])
  const [vendors, setVendors] = useState<string[]>([])
  const [connecting, setConnecting] = useState<string | null>(null) // drive id mid-consent
  const [error, setError] = useState("")
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (pollTimer.current) clearTimeout(pollTimer.current) }, [])

  useEffect(() => {
    if (!visible) return
    setError("")
    api.drives()
      .then((r) => { setDrives(r.drives || []); setVendors(r.vendors || []) })
      .catch((e) => setError((e as Error).message))
  }, [visible])

  function openIntegrations() {
    onClose()
    navigation.navigate("Integrations")
  }

  /** Run consent for `drive`, then select it. Polls every 2s until the flow
   *  ends; a failed/expired flow leaves the drive listed but unselected, with
   *  the reason shown — the user can retry from the same row. */
  async function connect(drive: Drive) {
    setError("")
    setConnecting(drive.id)
    try {
      const r = await api.driveOAuthStart(drive.id)
      if ("error" in r) {
        // "No <vendor> OAuth client configured …" is a setup gap, not a consent
        // failure: send the user to the screen that fixes it.
        if (/OAuth client/.test(r.error)) {
          Alert.alert(vendorLabel(drive.kind), r.error, [
            { text: "Later", style: "cancel" },
            { text: "Open Integrations", onPress: openIntegrations },
          ])
        }
        throw new Error(r.error)
      }
      await Linking.openURL(r.url)
      await new Promise<void>((resolve, reject) => {
        const tick = async () => {
          try {
            const s = await api.driveOAuthStatus(r.pending)
            if (s.status === "authorized") return resolve()
            if (s.status === "waiting") { pollTimer.current = setTimeout(tick, 2000); return }
            reject(new Error(s.error || `Consent ${s.status}`))
          } catch (e) { reject(e) }
        }
        tick()
      })
      const fresh = await api.drives()
      setDrives(fresh.drives || [])
      onChange(drive.id, fresh.drives || [])
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setConnecting(null)
    }
  }

  async function add(kind: string) {
    setError("")
    try {
      const r = await api.driveCreate({ label: vendorLabel(kind), kind })
      setDrives((all) => [...all, r.drive])
      await connect(r.drive)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  function remove(drive: Drive) {
    Alert.alert(`Remove “${drive.label}”?`, "Harman forgets its access token; nothing in the drive itself is touched.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove", style: "destructive",
        onPress: async () => {
          setError("")
          try {
            const r = await api.driveDelete(drive.id)
            if (r.error) throw new Error(r.error)
            const rest = drives.filter((d) => d.id !== drive.id)
            setDrives(rest)
            if (value === drive.id) onChange(HOST_LOCATION, rest)
          } catch (e) {
            setError((e as Error).message)
          }
        },
      },
    ])
  }

  const row = [styles.actionRow, { flexDirection: "row" as const, alignItems: "center" as const, opacity: connecting ? 0.6 : 1 }]

  return (
    <SheetModal visible={visible} onClose={onClose}>
      <View style={styles.sheetGrabber} />
      <Text style={styles.actionSheetTitle}>Location</Text>

      <TouchableOpacity testID="locpick-host" style={row} disabled={!!connecting} onPress={() => { onChange(HOST_LOCATION, drives); onClose() }}>
        <Icon name="server" size={18} color={value === HOST_LOCATION ? t.accent : t.textMuted} />
        <Text style={[styles.actionText, { flex: 1, marginLeft: 12, color: value === HOST_LOCATION ? t.accent : t.text }]} numberOfLines={1}>{hostLabel}</Text>
        {value === HOST_LOCATION ? <Icon name="check" size={16} color={t.accent} /> : null}
      </TouchableOpacity>

      {drives.map((d) => {
        const on = value === d.id
        const busy = connecting === d.id
        return (
          <TouchableOpacity key={d.id} testID={`locpick-${d.id}`} style={row} disabled={!!connecting} onPress={() => (d.authorized ? (onChange(d.id, drives), onClose()) : connect(d))}>
            <Icon name="cloud" size={18} color={on ? t.accent : t.textMuted} />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={[styles.actionText, { color: on ? t.accent : t.text }]} numberOfLines={1}>{d.label}</Text>
              <Text style={styles.rowSub} numberOfLines={1}>
                {busy ? "Waiting for consent in the browser…" : d.authorized ? vendorLabel(d.kind) : `${vendorLabel(d.kind)} — not connected yet, tap to sign in`}
              </Text>
            </View>
            {busy ? <ActivityIndicator size="small" /> : on ? <Icon name="check" size={16} color={t.accent} /> : null}
            <TouchableOpacity testID={`locpick-remove-${d.id}`} onPress={() => remove(d)} disabled={!!connecting} hitSlop={8} style={{ padding: 6, marginLeft: 6 }}>
              <Icon name="trash" size={16} color={t.textMuted} />
            </TouchableOpacity>
          </TouchableOpacity>
        )
      })}

      {vendors.map((k) => (
        <TouchableOpacity key={k} testID={`locpick-add-${k}`} style={row} disabled={!!connecting} onPress={() => add(k)}>
          <Icon name="add" size={18} color={t.accent} />
          <Text style={[styles.actionText, { color: t.accent, marginLeft: 12 }]}>Add {vendorLabel(k)}</Text>
        </TouchableOpacity>
      ))}

      <TouchableOpacity testID="locpick-integrations" style={row} disabled={!!connecting} onPress={openIntegrations}>
        <Icon name="settings" size={18} color={t.textMuted} />
        <Text style={[styles.actionText, { color: t.textMuted, marginLeft: 12 }]}>Integrations…</Text>
      </TouchableOpacity>

      {error ? <Text style={[styles.error, { paddingHorizontal: 16, paddingTop: 6 }]}>{error}</Text> : null}

      <TouchableOpacity style={styles.sheetCancel} onPress={onClose}>
        <Text style={styles.sheetCancelText}>Cancel</Text>
      </TouchableOpacity>
    </SheetModal>
  )
}

/** The header-right chip that opens the picker: a cloud/server icon + the
 *  current location's label. Lives in the Files header next to the host button. */
export function LocationHeaderButton({
  value,
  drives,
  hostLabel,
  onPress,
}: {
  value: Location
  drives: Drive[]
  hostLabel: string
  onPress: () => void
}) {
  const t = useTheme()
  const onDrive = value !== HOST_LOCATION
  return (
    <TouchableOpacity
      testID="location-header-button"
      accessibilityLabel="switch-location"
      onPress={onPress}
      hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
      style={{ flexDirection: "row", alignItems: "center", maxWidth: 120, height: 32 }}
    >
      <Icon name="cloud" size={19} color={onDrive ? t.accent : t.textMuted} />
      {onDrive ? (
        <Text style={{ color: t.accent, fontWeight: "600", marginLeft: 4, flexShrink: 1, fontSize: 13 }} numberOfLines={1} ellipsizeMode="tail">
          {describeLocation(value, drives, hostLabel)}
        </Text>
      ) : null}
    </TouchableOpacity>
  )
}
