import React from "react"
import { Text, TouchableOpacity, View } from "react-native"
import type { Provider } from "../api/client"
import { useTheme } from "../lib/useTheme"
import { useStyles } from "../screens/styles"
import Icon from "./Icon"
import SheetModal from "./SheetModal"

/**
 * A bottom-sheet dropdown for picking THIS session's model provider. Select-only:
 * it lists Default (Claude) + every saved provider with a checkmark on the current
 * one, and a "Manage providers →" row that jumps to the global library. It never
 * edits providers — that lives in ProvidersScreen (single source of CRUD).
 *
 * `selected` is the session's provider id ("" = Default). `onSelect` receives the
 * chosen id; the sheet closes itself after.
 */
export default function ProviderPicker({
  visible,
  providers,
  selected,
  onSelect,
  onClose,
  onManage,
}: {
  visible: boolean
  providers: Provider[]
  selected: string
  onSelect: (id: string) => void
  onClose: () => void
  onManage: () => void
}) {
  const styles = useStyles()
  const t = useTheme()

  function pick(id: string) {
    onSelect(id)
    onClose()
  }

  const rows: { id: string; label: string; sub?: string }[] = [
    { id: "", label: "Default (Claude)", sub: "Your Claude login" },
    ...providers.map((p) => ({ id: p.id, label: p.name, sub: p.model })),
  ]

  return (
    <SheetModal visible={visible} onClose={onClose}>
      <View style={styles.sheetGrabber} />
      <Text style={styles.actionSheetTitle}>Model provider</Text>

      {rows.map((r) => {
        const on = selected === r.id
        return (
          <TouchableOpacity
            key={r.id || "default"}
            testID={`providerpick-${r.id || "default"}`}
            style={[styles.actionRow, { flexDirection: "row", alignItems: "center" }]}
            onPress={() => pick(r.id)}
          >
            <Icon name={r.id ? "server" : "sparkle"} size={18} color={on ? t.accent : t.textMuted} />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={[styles.actionText, { color: on ? t.accent : t.text }]} numberOfLines={1}>{r.label}</Text>
              {r.sub ? <Text style={styles.rowSub} numberOfLines={1}>{r.sub}</Text> : null}
            </View>
            {on ? <Icon name="check" size={16} color={t.accent} /> : null}
          </TouchableOpacity>
        )
      })}

      <TouchableOpacity
        testID="providerpick-manage"
        style={[styles.actionRow, { flexDirection: "row", alignItems: "center" }]}
        onPress={() => {
          onClose()
          onManage()
        }}
      >
        <Icon name="add" size={18} color={t.accent} />
        <Text style={[styles.actionText, { color: t.accent, marginLeft: 12 }]}>Manage providers →</Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.sheetCancel} onPress={onClose}>
        <Text style={styles.sheetCancelText}>Cancel</Text>
      </TouchableOpacity>
    </SheetModal>
  )
}
