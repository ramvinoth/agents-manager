/**
 * JobScheduler — the add/edit job form, presented as a bottom sheet.
 *
 * The form scrolls inside the sheet while Cancel / Add stay pinned in a footer
 * below it, and SheetModal rides the whole sheet above the keyboard — so with
 * the keyboard up every field is reachable by scrolling and the buttons are
 * never hidden. Each opening remounts the form (a fresh `key`), which is how a
 * new job starts blank and an edit starts from that job's saved values.
 *
 * Two scheduling modes, chosen by a segmented toggle (see interval.ts for why
 * the axes are separate):
 *
 *   • Every N — a free numeric field + a Sec/Min/Hr unit toggle. Expresses any
 *     cadence, fractional units included ("every 7.5 min", "every 90 min",
 *     "every 7.5 hr"). Emits { interval } in seconds.
 *   • At set times — a wall-clock calendar (daily / weekdays / weekly / monthly)
 *     with a native time picker and day pickers. Emits { cron }.
 *   • Once — a single date+time on the device's clock. Emits { at } as ISO with
 *     the device's UTC offset; the server stores it as a one-shot (kind "once")
 *     that fires once and then retires.
 *
 * On submit, calls onSubmit(prompt, { cron?, interval?, at?, provider? }); the
 * caller closes the sheet.
 */
import React, { useState } from "react"
import { Platform, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native"
import SheetModal from "./SheetModal"
import DateTimePicker from "@react-native-community/datetimepicker"
import { type Provider } from "../api/client"
import {
  buildCron,
  CRON_KINDS,
  describeSchedule,
  INTERVAL_UNITS,
  parseCron,
  parseInterval,
  splitInterval,
  toIsoWithOffset,
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
  /** Saved one-shot: kind "once" with the fire time in nextRun (epoch seconds). */
  kind?: string
  nextRun?: number
  /** Unsaved one-shot draft (NewChat): the ISO `at` the form emitted. */
  at?: string
  /** Custom provider preset id these runs use ("" = inherit the session's own). */
  provider?: string
}

type Mode = "interval" | "cron" | "once"

export type JobSchedule = { cron?: string; interval?: number; at?: string; provider?: string }

function initialMode(v?: JobInitialValues): Mode {
  if (v?.cron) return "cron"
  if (v?.at || v?.kind === "once") return "once"
  return "interval"
}

/** The one-shot fire time an edit starts from, or a round hour from now. */
function initialOnce(v?: JobInitialValues): Date {
  const saved = v?.at ? Date.parse(v.at) : v?.kind === "once" && v.nextRun ? v.nextRun * 1000 : NaN
  if (!isNaN(saved)) return new Date(saved)
  const d = new Date(Date.now() + 3600e3)
  d.setMinutes(0, 0, 0)
  return d
}

type FormProps = {
  onSubmit: (prompt: string, schedule: JobSchedule) => void
  styles: ReturnType<typeof import("../lib/styles").useStyles>
  /** The job being edited; omit for a new job. */
  initialValues?: JobInitialValues
  onClose: () => void
  /** Saved provider presets. When passed, a "Model provider" picker appears so a
   *  job can pin its runs to a specific endpoint; omit it to hide the picker (the
   *  job then inherits the session's own provider). */
  providers?: Provider[]
}

export default function JobScheduler({ visible, ...form }: FormProps & { visible: boolean }) {
  // A new key on every opening remounts the form, so it starts from
  // initialValues (or blank) instead of whatever the last opening left behind.
  // Counted during render (not in an effect) so the first frame of the slide-in
  // already shows the fresh form.
  const [openings, setOpenings] = useState(0)
  const [wasVisible, setWasVisible] = useState(visible)
  if (visible !== wasVisible) {
    setWasVisible(visible)
    if (visible) setOpenings((n) => n + 1)
  }
  return (
    <SheetModal visible={visible} onClose={form.onClose}>
      <JobForm key={openings} {...form} />
    </SheetModal>
  )
}

function JobForm({ onSubmit, styles, initialValues, onClose, providers }: FormProps) {
  const t = useTheme()
  // Fixed for this opening: the caller clears initialValues as the sheet slides
  // out, and the title must not flip to "New job" mid-animation.
  const [isEdit] = useState(!!initialValues)

  const [prompt, setPrompt] = useState(initialValues?.prompt ?? "")
  const [mode, setMode] = useState<Mode>(initialMode(initialValues))

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

  // Once axis: a single local date+time.
  const [once, setOnce] = useState(() => initialOnce(initialValues))

  // Provider axis: which preset ("" = inherit the session's own) these runs use.
  // Only meaningful when `providers` is passed; otherwise the picker is hidden and
  // this stays "" (inherit).
  const [provider, setProvider] = useState(initialValues?.provider ?? "")

  // The schedule the current selection would produce — clamped, so the preview
  // is honest about the [30s, 24h] floor/ceiling the server enforces.
  const schedule: JobSchedule = {
    ...(mode === "cron"
      ? { cron: buildCron(kind, time.getHours(), time.getMinutes(), dow, dom) }
      : mode === "once"
        ? { at: toIsoWithOffset(once) }
        : { interval: parseInterval(`${amount || "0"}${unit}`) }),
    // Only carry provider when the picker is shown; NewChat jobs inherit the
    // session's provider and must not pin "" over it.
    ...(providers ? { provider } : {}),
  }

  function submit() {
    const p = prompt.trim()
    if (p) onSubmit(p, schedule)
  }

  const previewInterval = mode === "interval" ? (schedule.interval ?? 0) : 0

  return (
    <View style={styles.jobFormWrap}>
      <View style={styles.sheetGrabber} />
      <Text style={styles.sheetTitle}>{isEdit ? "Edit job" : "New job"}</Text>
      <ScrollView
        style={styles.jobScroll}
        contentContainerStyle={styles.jobScrollContent}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
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
      <Text style={[styles.sheetSection, styles.jobSectionTop]}>SCHEDULE</Text>
      <View style={styles.segRow}>
        {(
          [
            { v: "interval", label: "Every N" },
            { v: "cron", label: "At set times" },
            { v: "once", label: "Once" },
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
        <View style={styles.jobFieldGroup}>
          <View style={styles.jobRow}>
            <TextInput
              testID="job-interval-amount"
              style={[styles.ssInput, styles.jobAmountInput]}
              value={amount}
              onChangeText={(x) => setAmount(x.replace(/[^0-9.]/g, ""))}
              keyboardType="decimal-pad"
              placeholder="30"
              placeholderTextColor={t.textMuted}
            />
            <View style={styles.jobUnitRow}>
              {INTERVAL_UNITS.map((u) => {
                const active = unit === u.value
                return (
                  <TouchableOpacity
                    key={u.value}
                    testID={`job-unit-${u.value}`}
                    style={[styles.seg, styles.jobUnitSeg, active ? styles.segActive : null]}
                    onPress={() => setUnit(u.value)}
                  >
                    <Text style={[styles.segText, active ? styles.segTextActive : null]}>{u.label}</Text>
                  </TouchableOpacity>
                )
              })}
            </View>
          </View>
          <Text style={[styles.ssRowHint, styles.jobHint]}>
            {describeSchedule({ interval: previewInterval })} · runs on a sliding cadence, min 30s, max 24h.
          </Text>
        </View>
      ) : mode === "once" ? (
        /* ── Once: a single local date + time ── */
        <View style={styles.jobPickerGroup}>
          <Text style={styles.jobPickerLabel}>RUN ONCE AT</Text>
          <DateTimePicker
            testID="job-once-date"
            value={once}
            mode="date"
            minimumDate={new Date()}
            display={Platform.OS === "ios" ? "compact" : "default"}
            onChange={(_, d) => { if (d) setOnce(new Date(d.getFullYear(), d.getMonth(), d.getDate(), once.getHours(), once.getMinutes())) }}
            textColor={t.text}
          />
          <DateTimePicker
            testID="job-once-time"
            value={once}
            mode="time"
            display={Platform.OS === "ios" ? "spinner" : "default"}
            minuteInterval={5}
            onChange={(_, d) => { if (d) setOnce(new Date(once.getFullYear(), once.getMonth(), once.getDate(), d.getHours(), d.getMinutes())) }}
            textColor={t.text}
            style={styles.jobTimePicker}
          />
          <Text style={[styles.ssRowHint, styles.jobHint]}>
            {describeSchedule(schedule)} · fires once, then the job retires. A time already past fires on the next tick.
          </Text>
        </View>
      ) : (
        /* ── Cron: kind + time + day pickers ── */
        <>
          <View style={[styles.segRow, styles.jobKindRow]}>
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
          <View style={styles.jobPickerGroup}>
            <Text style={styles.jobPickerLabel}>AT TIME</Text>
            <DateTimePicker
              testID="job-time-picker"
              value={time}
              mode="time"
              display={Platform.OS === "ios" ? "spinner" : "default"}
              minuteInterval={5}
              onChange={(_, d) => { if (d) setTime(d) }}
              textColor={t.text}
              style={styles.jobTimePicker}
            />
          </View>

          {/* Day of week (weekly) */}
          {kind === "weekly" ? (
            <View style={styles.jobPickerGroup}>
              <Text style={styles.jobPickerLabel}>ON DAY</Text>
              <View style={styles.jobDayRow}>
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
            <View style={styles.jobPickerGroup}>
              <Text style={styles.jobPickerLabel}>ON DAY OF MONTH</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.jobDomScrollContent}>
                {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => {
                  const active = dom === d
                  return (
                    <TouchableOpacity
                      key={d}
                      testID={`job-dom-${d}`}
                      style={[styles.jobDomPill, active ? styles.jobDomPillActive : null]}
                      onPress={() => setDom(d)}
                    >
                      <Text style={[styles.jobDomText, active ? styles.jobDomTextActive : null]}>
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

      {/* Model provider — only when a providers list is supplied. "Inherit"
          resolves the session's own provider at fire time; pinning one overrides
          it (the preset carries the model). */}
      {providers ? (
        <>
          <Text style={[styles.sheetSection, styles.jobSectionTop]}>MODEL PROVIDER</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.sheetPills}>
            {[{ id: "", name: "Inherit session" }, ...providers].map((p) => {
              const active = provider === p.id
              return (
                <TouchableOpacity
                  key={p.id || "__inherit__"}
                  testID={`job-provider-${p.id || "inherit"}`}
                  style={[styles.sheetPill, active ? styles.sheetPillActive : null]}
                  onPress={() => setProvider(p.id)}
                >
                  <Text style={[styles.sheetPillText, active ? styles.sheetPillTextActive : null]}>{p.name}</Text>
                </TouchableOpacity>
              )
            })}
          </ScrollView>
        </>
      ) : null}

      </ScrollView>

      {/* Footer: outside the scroll, so it stays on screen above the keyboard. */}
      <View style={styles.jobFooter}>
        <TouchableOpacity
          testID="job-cancel"
          style={[styles.ssAddBtn, styles.jobCancelBtn]}
          onPress={onClose}
        >
          <Text style={[styles.ssAddBtnText, styles.jobCancelText]}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="job-add"
          style={[styles.ssAddBtn, styles.jobAddBtn, prompt.trim() ? null : styles.dimmed]}
          disabled={!prompt.trim()}
          onPress={submit}
        >
          <Text style={styles.ssAddBtnText}>{isEdit ? "Save" : "Add job"}</Text>
        </TouchableOpacity>
      </View>
    </View>
  )
}
