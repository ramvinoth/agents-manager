/**
 * JobScheduler — the "new job" creation form with a proper scheduling UX.
 *
 * Replaces the old bare-text-input loop creator. Provides:
 * - A prompt text field (what to run)
 * - A frequency picker (every 30m … monthly)
 * - A native iOS time picker (for daily/weekly/monthly)
 * - A day-of-week picker (for weekly)
 * - A day-of-month picker (for monthly)
 *
 * On submit, builds a cron expression or interval and calls the API.
 */
import React, { useEffect, useState } from "react"
import { Platform, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native"
import DateTimePicker from "@react-native-community/datetimepicker"
import {
  buildSchedule,
  FREQUENCIES,
  frequencyNeedsDom,
  frequencyNeedsDow,
  frequencyNeedsTime,
  frequencyUsesCron,
  parseCron,
  WEEKDAYS,
  type Frequency,
} from "../lib/interval"
import { useTheme } from "../lib/useTheme"
import Icon from "./Icon"

/** Values used to pre-fill the form when editing an existing job. */
export type JobInitialValues = {
  prompt: string
  cron?: string
  interval?: number
}

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

  // Parse initialValues into form state.
  const parsed = initialValues?.cron ? parseCron(initialValues.cron) : null
  const intervalFreq = initialValues?.interval
    ? initialValues.interval <= 1800 ? "every_30m"
      : initialValues.interval <= 3600 ? "hourly"
      : initialValues.interval <= 7200 ? "every_2h"
      : initialValues.interval <= 14400 ? "every_4h"
      : initialValues.interval <= 21600 ? "every_6h"
      : "every_12h" as Frequency
    : null

  const [prompt, setPrompt] = useState(initialValues?.prompt ?? "")
  const [freq, setFreq] = useState<Frequency>(parsed?.freq ?? intervalFreq ?? "daily")
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
    const p = initialValues.cron ? parseCron(initialValues.cron) : null
    const intf = initialValues.interval
      ? initialValues.interval <= 1800 ? "every_30m"
        : initialValues.interval <= 3600 ? "hourly"
        : initialValues.interval <= 7200 ? "every_2h"
        : initialValues.interval <= 14400 ? "every_4h"
        : initialValues.interval <= 21600 ? "every_6h"
        : "every_12h" as Frequency
      : null
    setFreq(p?.freq ?? intf ?? "daily")
    const d = new Date()
    d.setHours(p?.hour ?? 9, p?.minute ?? 0, 0, 0)
    setTime(d)
    setDow(p?.dow ?? 1)
    setDom(p?.dom ?? 1)
  }, [initialValues?.prompt, initialValues?.cron, initialValues?.interval]) // eslint-disable-line react-hooks/exhaustive-deps

  const showTime = frequencyNeedsTime(freq)
  const showDow = frequencyNeedsDow(freq)
  const showDom = frequencyNeedsDom(freq)

  function submit() {
    const p = prompt.trim()
    if (!p) return
    const schedule = buildSchedule(freq, time.getHours(), time.getMinutes(), dow, dom)
    onSubmit(p, schedule)
    if (!isEdit) setPrompt("")
  }

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

      {/* Frequency picker */}
      <Text style={[styles.sheetSection, { marginTop: 12 }]}>FREQUENCY</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 18, gap: 6, paddingBottom: 4 }}
      >
        {FREQUENCIES.map((f) => {
          const active = freq === f.value
          return (
            <TouchableOpacity
              key={f.value}
              testID={`job-freq-${f.value}`}
              style={[
                styles.sheetPill,
                active ? styles.sheetPillActive : null,
              ]}
              onPress={() => setFreq(f.value)}
            >
              {active ? <Icon name="check" size={14} color="#fff" /> : null}
              <Text style={[styles.sheetPillText, active ? styles.sheetPillTextActive : null]}>
                {f.label}
              </Text>
            </TouchableOpacity>
          )
        })}
      </ScrollView>

      {/* Time picker (iOS native wheel) */}
      {showTime ? (
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
      ) : null}

      {/* Day of week picker (weekly) */}
      {showDow ? (
        <View style={{ marginHorizontal: 18, marginTop: 8 }}>
          <Text style={{ color: t.textMuted, fontSize: 12, marginBottom: 6 }}>ON DAY</Text>
          <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
            {WEEKDAYS.map((day, i) => {
              const active = dow === i
              return (
                <TouchableOpacity
                  key={day}
                  testID={`job-dow-${i}`}
                  style={[
                    styles.sheetPill,
                    active ? styles.sheetPillActive : null,
                  ]}
                  onPress={() => setDow(i)}
                >
                  <Text style={[styles.sheetPillText, active ? styles.sheetPillTextActive : null]}>
                    {day}
                  </Text>
                </TouchableOpacity>
              )
            })}
          </View>
        </View>
      ) : null}

      {/* Day of month picker (monthly) */}
      {showDom ? (
        <View style={{ marginHorizontal: 18, marginTop: 8 }}>
          <Text style={{ color: t.textMuted, fontSize: 12, marginBottom: 6 }}>ON DAY OF MONTH</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 4 }}
          >
            {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => {
              const active = dom === d
              return (
                <TouchableOpacity
                  key={d}
                  testID={`job-dom-${d}`}
                  style={[
                    {
                      width: 36,
                      height: 36,
                      borderRadius: 18,
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: active ? t.accent : t.surface,
                      borderWidth: active ? 0 : 1,
                      borderColor: t.border,
                    },
                  ]}
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
