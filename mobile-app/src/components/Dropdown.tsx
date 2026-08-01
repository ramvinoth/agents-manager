import React, { useState } from "react"
import { Modal, Pressable, Text, TouchableOpacity, View } from "react-native"
import Icon from "./Icon"
import { useTheme } from "../lib/useTheme"
import { useStyles } from "../screens/styles"

export type Option = { v: string; label: string }

// A compact select control — the mobile equivalent of the web composer's
// shadcn <Select> (permission mode / model). Tapping opens a bottom sheet.
export default function Dropdown({
  value,
  options,
  onChange,
  testIDPrefix,
}: {
  value: string
  options: Option[]
  onChange: (v: string) => void
  testIDPrefix: string
}) {
  const [open, setOpen] = useState(false)
  const current = options.find((o) => o.v === value) || options[0]
  const styles = useStyles()
  const t = useTheme()
  return (
    <>
      <TouchableOpacity testID={`${testIDPrefix}-trigger`} style={[styles.ddTrigger, styles.drawerCheckRow]} onPress={() => setOpen(true)}>
        <Text style={styles.ddTriggerText}>{current?.label}</Text>
        <Icon name="chevronDown" size={13} color={t.textMuted} />
      </TouchableOpacity>
      <Modal transparent visible={open} animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.ddScrim} onPress={() => setOpen(false)}>
          <View style={styles.ddSheet}>
            {options.map((o) => (
              <TouchableOpacity
                key={o.v}
                testID={`${testIDPrefix}-${o.v}`}
                style={styles.ddItem}
                onPress={() => {
                  onChange(o.v)
                  setOpen(false)
                }}
              >
                <View style={styles.drawerCheckRow}>
                  <Text style={[styles.ddItemText, o.v === value ? styles.ddItemActive : null]}>{o.label}</Text>
                  {o.v === value ? <Icon name="check" size={15} color={t.accent} /> : null}
                </View>
              </TouchableOpacity>
            ))}
          </View>
        </Pressable>
      </Modal>
    </>
  )
}
