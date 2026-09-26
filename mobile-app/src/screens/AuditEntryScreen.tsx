import React from "react"
import { Pressable, ScrollView, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { auditSubject, auditTimestamp, resultTone } from "../lib/audit"
import { formatActor } from "../lib/board"
import { username } from "../state/config"
import { useTheme } from "../lib/useTheme"
import { ActorBadge, toneColors } from "./AuditScreen"

type Props = NativeStackScreenProps<RootStackParamList, "AuditEntry">

/**
 * One recorded action, read top to bottom: who and what (the same sentence as
 * the feed row), the result with its plain-language meaning, then the facts
 * a person would quote when asking "what happened here?".
 */
export default function AuditEntryScreen({ route, navigation }: Props) {
  const t = useTheme()
  const insets = useSafeAreaInsets()
  const { entry } = route.params
  const who = formatActor(entry.actor, username())
  const chip = toneColors(t, resultTone(entry.result.category))
  const cardId = entry.target.card_id
  const canOpenCard = Number.isSafeInteger(cardId) && (cardId ?? 0) > 0
  const facts = [
    { label: "Actor", value: entry.actor },
    { label: "Target", value: entry.target.label },
    { label: "Recorded at", value: auditTimestamp(entry.created_at) },
    { label: "Record ID", value: String(entry.id) },
  ]

  return (
    <ScrollView testID="audit-entry" style={{ flex: 1, backgroundColor: t.bg }} contentContainerStyle={{ padding: 16, paddingBottom: Math.max(insets.bottom, 20), gap: 16 }}>
      <View style={{ flexDirection: "row", gap: 12, alignItems: "flex-start" }}>
        <ActorBadge name={who.name} kind={who.kind} t={t} size={40} />
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={{ color: t.textMuted, fontSize: 13 }}>{who.name} · {entry.action}</Text>
          <Text selectable accessibilityRole="header" style={{ color: t.text, fontSize: 22, fontWeight: "700", lineHeight: 28 }}>{auditSubject(entry.target)}</Text>
        </View>
      </View>

      <View style={{ backgroundColor: t.surface, borderRadius: 14, padding: 14, gap: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Text accessibilityRole="header" style={{ color: t.textMuted, fontSize: 12, fontWeight: "700", letterSpacing: 0.6, textTransform: "uppercase" }}>Recorded result</Text>
          <View style={{ paddingHorizontal: 9, paddingVertical: 3, borderRadius: 7, backgroundColor: chip.bg }}>
            <Text style={{ color: chip.fg, fontSize: 13, fontWeight: "600" }}>{entry.result.label}</Text>
          </View>
        </View>
        <Text selectable style={{ color: t.text, fontSize: 15, lineHeight: 21 }}>{entry.result.explanation}</Text>
        <Text style={{ color: t.textMuted, fontSize: 13, lineHeight: 18 }}>A record of what happened then, not the card’s state now.</Text>
      </View>

      <View style={{ backgroundColor: t.surface, borderRadius: 14, paddingHorizontal: 14 }}>
        {facts.map((fact, i) => <View key={fact.label} style={{ paddingVertical: 12, borderTopWidth: i ? 1 : 0, borderColor: t.border, flexDirection: "row", gap: 12 }}>
          <Text accessibilityRole="header" style={{ color: t.textMuted, fontSize: 14, width: 96 }}>{fact.label}</Text>
          <Text selectable style={{ color: t.text, fontSize: 15, flex: 1, fontVariant: ["tabular-nums"] }}>{fact.value}</Text>
        </View>)}
      </View>

      {canOpenCard ? <Pressable
        testID="audit-entry-card"
        accessibilityRole="button"
        accessibilityLabel={`Open card ${cardId}`}
        accessibilityHint="Opens the card’s current details if available"
        onPress={() => navigation.navigate("CardDetail", { id: cardId! })}
        style={({ pressed }) => ({ minHeight: 48, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: t.text, opacity: pressed ? 0.85 : 1 })}
      >
        <Text style={{ color: t.bg, fontSize: 16, fontWeight: "600" }}>Open card</Text>
      </Pressable> : null}
    </ScrollView>
  )
}
