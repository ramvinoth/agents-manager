import React from "react"
import { Pressable, ScrollView, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { auditTimestamp } from "../lib/audit"
import { useTheme } from "../lib/useTheme"

type Props = NativeStackScreenProps<RootStackParamList, "AuditEntry">

export default function AuditEntryScreen({ route, navigation }: Props) {
  const t = useTheme()
  const insets = useSafeAreaInsets()
  const { entry } = route.params
  const cardId = entry.target.card_id
  const canOpenCard = Number.isSafeInteger(cardId) && (cardId ?? 0) > 0
  const fields = [
    { label: "Actor", value: entry.actor },
    { label: "Target", value: entry.target.label },
    { label: "Recorded result", value: entry.result.label, explanation: entry.result.explanation },
    { label: "Recorded at", value: auditTimestamp(entry.created_at) },
    { label: "Record ID", value: String(entry.id) },
  ]

  return (
    <ScrollView testID="audit-entry" style={{ flex: 1, backgroundColor: t.bg }} contentContainerStyle={{ padding: 20, paddingBottom: Math.max(insets.bottom, 20) }}>
      <Text selectable accessibilityRole="header" style={{ color: t.text, fontSize: 24, fontWeight: "600", marginBottom: 24 }}>{entry.action}</Text>
      {fields.map(field => <View key={field.label} style={{ marginBottom: 24 }}>
        <Text accessibilityRole="header" style={{ color: t.text, fontSize: 14, fontWeight: "600", marginBottom: 6 }}>{field.label}</Text>
        <Text selectable style={{ color: t.text, fontSize: 17 }}>{field.value}</Text>
        {field.explanation ? <Text selectable style={{ color: t.text, fontSize: 16, marginTop: 10 }}>{field.explanation}</Text> : null}
      </View>)}
      <Text style={{ color: t.text, fontSize: 15, marginBottom: 16 }}>This is a historical record, not the current state of the action or an approval request.</Text>
      {canOpenCard ? <Pressable
        testID="audit-entry-card"
        accessibilityRole="button"
        accessibilityLabel={`Open card ${cardId}`}
        accessibilityHint="Opens the card’s current details if available"
        onPress={() => navigation.navigate("CardDetail", { id: cardId! })}
        style={{ minHeight: 44, paddingVertical: 14, borderTopWidth: 1, borderColor: t.border }}
      >
        <Text style={{ color: t.text, fontSize: 17, fontWeight: "600" }}>Open card</Text>
      </Pressable> : null}
    </ScrollView>
  )
}
