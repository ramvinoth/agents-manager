/**
 * JobScheduler — the "new job" creation form.
 *
 * Two scheduling modes, chosen by a segmented toggle (see interval.ts for why
 * the axes are separate):
 *
 *   • Every N — a free numeric field + a Sec/Min/Hr unit toggle. Expresses any
 *     cadence, fractional units included ("every 7.5 min", "every 90 min",
 *     "every 7.5 hr"). Emits { interval } in seconds.
 *   • At set times — a wall-clock calendar (daily / weekdays / weekly / monthly)
 *     with a native time picker and day pickers. Emits { cron }.
 *
 * On submit, calls onSubmit(prompt, { cron?, interval? }) — the same contract
 * every consumer screen already relies on.
 */
import React, { useEffect, useState } from "react"
import { Platform, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native"
import DateTimePicker from "@react-native-community/datetimepicker"
import {
  buildCron,
  CRON_KINDS,
  describeSchedule,
  INTERVAL_UNITS,
  parseCron,
  parseInterval,
  splitInterval,
  WEEKDAYS,
  type CronKind,
  type IntervalUnit,
} from "../lib/interval"
import { useTheme } from "../lib/useTheme"

/** Values used to pre-fill the form when editing an existing job. */
export type JobInitialValues = {
  prompt: string
  cron?: string
  interval?: number
}

type Mode = "interval" | "cron"

export default function JobScheduler({
  onSubmit,
  styles,
  initialValues,
  onCancel,
}: {
  onSubmit: (prompt: string, schedule: { cron?: string; interval?: number }) => void
  styles: ReturnType<typeof import("../screens/styles").useStyles>
  /** When set, pre-fills the form for editing. */
  initialValues?: JobInitialValues
  /** Called when the user cancels editing (only shown in edit mode). */
  onCancel?: () => void
}) {
  const t = useTheme()
  const isEdit = !!initialValues

  const [prompt, setPrompt] = useState(initialValues?.prompt ?? "")
  const [mode, setMode] = useState<Mode>(initialValues?.cron ? "cron" : "interval")

  // Interval axis: a free numeric string + a unit. Kept as text so the field
  // can be empty mid-edit; parsed (and clamped) only on submit.
  const initSplit = initialValues?.interval && !initialValues.cron ? splitInterval(initialValues.interval) : null
  const [amount, setAmount] = useState(initSplit ? String(initSplit.value) : "30")
  const [unit, setUnit] = useState<IntervalUnit>(initSplit?.unit ?? "m")

  // Cron axis: kind + time + day pickers.
  const parsed = initialValues?.cron ? parseCron(initialValues.cron) : null
  const [kind, setKind] = useState<CronKind>(parsed?.kind ?? "daily")
  const [time, setTime] = useState(() => {
    const d = new Date()
    d.setHours(parsed?.hour ?? 9, parsed?.minute ?? 0, 0, 0)
    return d
  })
  const [dow, setDow] = useState(parsed?.dow ?? 1)
  const [dom, setDom] = useState(parsed?.dom ?? 1)

  // Reset form when initialValues changes (e.g. tapping a different job to edit).
  useEffect(() => {
    if (!initialValues) return
    setPrompt(initialValues.prompt)
    setMode(initialValues.cron ? "cron" : "interval")
    const sp = initialValues.interval && !initialValues.cron ? splitInterval(initialValues.interval) : null
    setAmount(sp ? String(sp.value) : "30")
    setUnit(sp?.unit ?? "m")
    const p = initialValues.cron ? parseCron(initialValues.cron) : null
    setKind(p?.kind ?? "daily")
    const d = new Date()
    d.setHours(p?.hour ?? 9, p?.minute ?? 0, 0, 0)
    setTime(d)
    setDow(p?.dow ?? 1)
    setDom(p?.dom ?? 1)
  }, [initialValues?.prompt, initialValues?.cron, initialValues?.interval]) // eslint-disable-line react-hooks/exhaustive-deps

  // The schedule the current selection would produce — clamped, so the preview
  // is honest about the [30s, 24h] floor/ceiling the server enforces.
  const schedule: { cron?: string; interval?: number } =
    mode === "cron"
      ? { cron: buildCron(kind, time.getHours(), time.getMinutes(), dow, dom) }
      : { interval: parseInterval(`${amount || "0"}${unit}`) }

  function submit() {
    const p = prompt.trim()
    if (!p) return
    onSubmit(p, schedule)
    if (!isEdit) {
      setPrompt("")
      setAmount("30")
      setUnit("m")
    }
  }

  const previewInterval = mode === "interval" ? (schedule.interval ?? 0) : 0

  return (
    <View>
      {/* Prompt */}
      <TextInput
        testID="job-prompt"
        style={[styles.ssInput, styles.ssMultiline]}
        value={prompt}
        onChangeText={setPrompt}
        placeholder="What should this job do?"
        placeholderTextColor={t.textMuted}
        multiline
      />

      {/* Mode toggle: interval vs cron */}
      <Text style={[styles.sheetSection, { marginTop: 12 }]}>SCHEDULE</Text>
      <View style={styles.segRow}>
        {(
          [
            { v: "interval", label: "Every N" },
            { v: "cron", label: "At set times" },
          ] as { v: Mode; label: string }[]
        ).map((o) => {
          const active = mode === o.v
          return (
            <TouchableOpacity
              key={o.v}
              testID={`job-mode-${o.v}`}
              style={[styles.seg, active ? styles.segActive : null]}
              onPress={() => setMode(o.v)}
            >
              <Text style={[styles.segText, active ? styles.segTextActive : null]}>{o.label}</Text>
            </TouchableOpacity>
          )
        })}
      </View>

      {/* ── Interval: free amount + unit ── */}
      {mode === "interval" ? (
        <View style={{ marginHorizontal: 16, marginTop: 10 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <TextInput
              testID="job-interval-amount"
              style={[styles.ssInput, { flex: 1, marginBottom: 0, textAlign: "center", fontSize: 18, fontWeight: "700" }]}
              value={amount}
              onChangeText={(x) => setAmount(x.replace(/[^0-9.]/g, ""))}
              keyboardType="decimal-pad"
              placeholder="30"
              placeholderTextColor={t.textMuted}
            />
            <View style={{ flexDirection: "row", gap: 6 }}>
              {INTERVAL_UNITS.map((u) => {
                const active = unit === u.value
                return (
                  <TouchableOpacity
                    key={u.value}
                    testID={`job-unit-${u.value}`}
                    style={[styles.seg, { flex: 0, paddingHorizontal: 16 }, active ? styles.segActive : null]}
                    onPress={() => setUnit(u.value)}
                  >
                    <Text style={[styles.segText, active ? styles.segTextActive : null]}>{u.label}</Text>
                  </TouchableOpacity>
                )
              })}
            </View>
          </View>
          <Text style={[styles.ssRowHint, { marginTop: 8, maxWidth: undefined }]}>
            {describeSchedule({ interval: previewInterval })} · runs on a sliding cadence, min 30s, max 24h.
          </Text>
        </View>
      ) : (
        /* ── Cron: kind + time + day pickers ── */
        <>
          <View style={[styles.segRow, { marginTop: 10, flexWrap: "wrap" }]}>
            {CRON_KINDS.map((k) => {
              const active = kind === k.value
              return (
                <TouchableOpacity
                  key={k.value}
                  testID={`job-kind-${k.value}`}
                  style={[styles.seg, active ? styles.segActive : null]}
                  onPress={() => setKind(k.value)}
                >
                  <Text style={[styles.segText, active ? styles.segTextActive : null]}>{k.label}</Text>
                </TouchableOpacity>
              )
            })}
          </View>

          {/* Time-of-day (all cron kinds) */}
          <View style={{ marginHorizontal: 18, marginTop: 8 }}>
            <Text style={{ color: t.textMuted, fontSize: 12, marginBottom: 4 }}>AT TIME</Text>
            <DateTimePicker
              testID="job-time-picker"
              value={time}
              mode="time"
              display={Platform.OS === "ios" ? "spinner" : "default"}
              minuteInterval={5}
              onChange={(_, d) => { if (d) setTime(d) }}
              textColor={t.text}
              style={{ height: 120 }}
            />
          </View>

          {/* Day of week (weekly) */}
          {kind === "weekly" ? (
            <View style={{ marginHorizontal: 18, marginTop: 8 }}>
              <Text style={{ color: t.textMuted, fontSize: 12, marginBottom: 6 }}>ON DAY</Text>
              <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
                {WEEKDAYS.map((day, i) => {
                  const active = dow === i
                  return (
                    <TouchableOpacity
                      key={day}
                      testID={`job-dow-${i}`}
                      style={[styles.sheetPill, active ? styles.sheetPillActive : null]}
                      onPress={() => setDow(i)}
                    >
                      <Text style={[styles.sheetPillText, active ? styles.sheetPillTextActive : null]}>{day}</Text>
                    </TouchableOpacity>
                  )
                })}
              </View>
            </View>
          ) : null}

          {/* Day of month (monthly) — 1..28 only, so every month has the day */}
          {kind === "monthly" ? (
            <View style={{ marginHorizontal: 18, marginTop: 8 }}>
              <Text style={{ color: t.textMuted, fontSize: 12, marginBottom: 6 }}>ON DAY OF MONTH</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 4 }}>
                {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => {
                  const active = dom === d
                  return (
                    <TouchableOpacity
                      key={d}
                      testID={`job-dom-${d}`}
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: 18,
                        alignItems: "center",
                        justifyContent: "center",
                        backgroundColor: active ? t.accent : t.surface,
                        borderWidth: active ? 0 : 1,
                        borderColor: t.border,
                      }}
                      onPress={() => setDom(d)}
                    >
                      <Text style={{ color: active ? "#fff" : t.text, fontSize: 13, fontWeight: active ? "700" : "400" }}>
                        {d}
                      </Text>
                    </TouchableOpacity>
                  )
                })}
              </ScrollView>
            </View>
          ) : null}
        </>
      )}

      {/* Submit + Cancel */}
      <View style={{ marginHorizontal: 18, marginTop: 12, flexDirection: "row", gap: 8 }}>
        {isEdit && onCancel ? (
          <TouchableOpacity
            testID="job-cancel"
            style={[styles.ssAddBtn, { flex: 1, backgroundColor: t.chipBg }]}
            onPress={onCancel}
          >
            <Text style={[styles.ssAddBtnText, { color: t.text }]}>Cancel</Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity
          testID="job-add"
          style={[styles.ssAddBtn, { flex: 1, opacity: prompt.trim() ? 1 : 0.5 }]}
          disabled={!prompt.trim()}
          onPress={submit}
        >
          <Text style={styles.ssAddBtnText}>{isEdit ? "Update job" : "Add job"}</Text>
        </TouchableOpacity>
      </View>
    </View>
  )
}
