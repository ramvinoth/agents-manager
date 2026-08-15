import React, { useEffect, useState } from "react"
import { Text, TextInput, TouchableOpacity, View } from "react-native"
import SheetModal from "./SheetModal"
import { useStyles } from "../screens/styles"
import { useTheme } from "../lib/useTheme"

/**
 * A field in a CreateSheet form. `key` is the value returned; `suggestions` render
 * as tappable chips above the input (e.g. recent working dirs for a project cwd).
 */
export type CreateField = {
  key: string
  label: string
  placeholder?: string
  required?: boolean
  autoCapitalize?: "none" | "sentences"
  suggestions?: string[]
}

/**
 * Cross-platform "create X" bottom sheet — the replacement for `Alert.prompt`,
 * which only exists on iOS (so the old inline prompt silently no-opped on
 * Android). Renders a titled form of labelled inputs over the shared SheetModal;
 * calls `onSubmit` with a {key: value} map once the required fields are filled.
 *
 * Deliberately field-driven (not one hard-coded form) so the same component backs
 * both "new project" (name + workspace dir) and "new employee" (name + role) — one
 * source of truth for the create-form look, per the no-duplicate-implementations rule.
 */
export default function CreateSheet({
  visible,
  title,
  fields,
  submitLabel = "Create",
  onSubmit,
  onClose,
}: {
  visible: boolean
  title: string
  fields: CreateField[]
  submitLabel?: string
  onSubmit: (values: Record<string, string>) => void | Promise<void>
  onClose: () => void
}) {
  const styles = useStyles()
  const t = useTheme()
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  // Reset the form each time the sheet opens so stale input never carries over.
  useEffect(() => {
    if (visible) { setValues({}); setBusy(false) }
  }, [visible])

  const canSubmit = fields.every((f) => !f.required || (values[f.key] || "").trim())

  async function submit() {
    if (!canSubmit || busy) return
    setBusy(true)
    try {
      await onSubmit(Object.fromEntries(fields.map((f) => [f.key, (values[f.key] || "").trim()])))
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <SheetModal visible={visible} onClose={onClose}>
      <View style={styles.sheetGrabber} />
      <Text style={styles.sheetTitle}>{title}</Text>
      {fields.map((f) => (
        <View key={f.key} style={{ paddingHorizontal: 18, marginTop: 12 }}>
          <Text style={{ color: t.textMuted, fontSize: 12, marginBottom: 6 }}>
            {f.label}{f.required ? "" : "  (optional)"}
          </Text>
          <TextInput
            testID={`create-${f.key}`}
            style={[styles.input, { color: t.text, borderColor: t.border }]}
            value={values[f.key] || ""}
            onChangeText={(v) => setValues((cur) => ({ ...cur, [f.key]: v }))}
            placeholder={f.placeholder}
            placeholderTextColor={t.textMuted}
            autoCapitalize={f.autoCapitalize || "sentences"}
            autoCorrect={false}
          />
          {f.suggestions?.length ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
              {f.suggestions.slice(0, 6).map((s) => (
                <TouchableOpacity
                  key={s}
                  testID={`create-${f.key}-suggest`}
                  onPress={() => setValues((cur) => ({ ...cur, [f.key]: s }))}
                  style={{ borderRadius: 12, paddingHorizontal: 10, paddingVertical: 5, backgroundColor: t.chipBg }}
                >
                  <Text style={{ color: t.text, fontSize: 12 }} numberOfLines={1}>{s}</Text>
                </TouchableOpacity>
              ))}
            </View>
          ) : null}
        </View>
      ))}
      <View style={{ flexDirection: "row", gap: 10, paddingHorizontal: 18, marginTop: 20 }}>
        <TouchableOpacity testID="create-cancel" onPress={onClose} style={{ flex: 1, borderRadius: 10, borderWidth: 1, borderColor: t.border, paddingVertical: 12, alignItems: "center" }}>
          <Text style={{ color: t.textMuted, fontWeight: "600" }}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="create-submit"
          onPress={submit}
          disabled={!canSubmit || busy}
          style={{ flex: 1, borderRadius: 10, paddingVertical: 12, alignItems: "center", backgroundColor: t.accent, opacity: !canSubmit || busy ? 0.5 : 1 }}
        >
          <Text style={{ color: "#fff", fontWeight: "700" }}>{busy ? "…" : submitLabel}</Text>
        </TouchableOpacity>
      </View>
    </SheetModal>
  )
}
