import React, { useEffect, useMemo, useRef, useState } from "react"
import { ScrollView, Text, View, type NativeSyntheticEvent, type TextInputSelectionChangeEventData } from "react-native"
import { TouchableOpacity } from "./Tracked"
import Icon from "./Icon"
import { api, type SlashCommand } from "../api/client"
import { matchCommands, slashTerm } from "../lib/slash"
import { applyMention, hashTerm } from "../lib/fileMention"
import { useStyles } from "../lib/styles"
import { useTheme } from "../lib/useTheme"

type FileHit = { path: string; dir: boolean }

/** Composer completion: "/foo" lists the host's slash commands, "#word" at the
 *  caret searches the session's project (lib/fileMention.ts) and a pick swaps
 *  it for @path, which Claude Code inlines. Spread `inputProps` on the
 *  composer's TextInput and render <ComposerSuggestions {...completion} />. */
export function useComposerCompletion(opts: {
  input: string
  setInput: (text: string) => void
  host: string
  cwd?: string
}) {
  const { input, setInput, host, cwd } = opts
  const [commands, setCommands] = useState<SlashCommand[]>([])
  // Slash commands are host-scoped and rarely change: fetch once per host.
  useEffect(() => {
    api.commands(host).then((c) => setCommands(Array.isArray(c) ? c : [])).catch(() => {})
  }, [host])
  const slashMatches = useMemo(() => matchCommands(slashTerm(input), commands), [input, commands])
  const [caret, setCaret] = useState<number | null>(null)
  // Set only right after a pick to place the caret past the mention; left
  // uncontrolled otherwise so iOS typing never fights a stale selection.
  const [placeCaret, setPlaceCaret] = useState<number | null>(null)
  const [fileHits, setFileHits] = useState<FileHit[]>([])
  const hash = useMemo(() => (caret === null ? null : hashTerm(input, caret)), [input, caret])
  const hashQuery = hash?.query ?? null
  useEffect(() => {
    if (hashQuery === null || !cwd) {
      setFileHits([])
      return
    }
    let live = true
    const timer = setTimeout(() => {
      api.fsSearch(host, cwd, hashQuery)
        .then((r) => { if (live) setFileHits(r.results || []) })
        .catch(() => { if (live) setFileHits([]) })
    }, 150)
    return () => { live = false; clearTimeout(timer) }
  }, [hashQuery, cwd, host])
  const fileMatches = slashMatches.length || !hash ? [] : fileHits
  // iOS can answer the pick with a change event still carrying the pre-pick
  // text (the keyboard committing as the row is tapped); that echo would undo
  // the mention. Until the user's next real edit, the old text maps back to
  // the picked one.
  const pickEcho = useRef<{ from: string; to: string } | null>(null)
  const pickFile = (p: string) => {
    if (!hash || caret === null) return
    const r = applyMention(input, hash, caret, p)
    pickEcho.current = { from: input, to: r.text }
    setInput(r.text)
    setCaret(r.caret)
    setPlaceCaret(r.caret)
    setFileHits([])
  }
  const inputProps = {
    onChangeText: (text: string) => {
      const echo = pickEcho.current
      pickEcho.current = null
      setInput(echo && text === echo.from ? echo.to : text)
    },
    onSelectionChange: (e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
      const { start, end } = e.nativeEvent.selection
      setCaret(start === end ? start : null)
      setPlaceCaret(null)
    },
    selection: placeCaret === null ? undefined : { start: placeCaret, end: placeCaret },
  }
  const pickCommand = (name: string) => setInput(`/${name} `)
  return { slashMatches, fileMatches, pickCommand, pickFile, inputProps }
}

/** The suggestion list above the composer: slash commands, else file hits. */
export default function ComposerSuggestions(props: {
  slashMatches: SlashCommand[]
  fileMatches: FileHit[]
  pickCommand: (name: string) => void
  pickFile: (path: string) => void
}) {
  const { slashMatches, fileMatches, pickCommand, pickFile } = props
  const styles = useStyles()
  const t = useTheme()
  if (slashMatches.length) {
    return (
      <View testID="slash-list" style={styles.slashList}>
        <ScrollView keyboardShouldPersistTaps="always" style={{ maxHeight: 190 }}>
          {slashMatches.map((c) => (
            <TouchableOpacity
              key={c.name}
              testID={`slash-${c.name}`}
              style={styles.slashRow}
              onPress={() => pickCommand(c.name)}
            >
              <Text style={styles.slashName}>/{c.name}</Text>
              {c.description ? (
                <Text style={styles.slashDesc} numberOfLines={1}>
                  {c.description}
                </Text>
              ) : null}
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>
    )
  }
  if (!fileMatches.length) return null
  return (
    <View testID="file-mention-list" style={styles.slashList}>
      <ScrollView keyboardShouldPersistTaps="always" style={{ maxHeight: 190 }}>
        {fileMatches.map((f) => {
          const cut = f.path.lastIndexOf("/") + 1
          return (
            <TouchableOpacity
              key={f.path}
              testID={`file-mention-${f.path}`}
              style={[styles.slashRow, { flexDirection: "row", alignItems: "center", gap: 8 }]}
              onPress={() => pickFile(f.path)}
            >
              <Icon name={f.dir ? "folder" : "file"} size={15} color={t.textMuted} />
              <View style={{ flex: 1 }}>
                <Text style={styles.slashName} numberOfLines={1}>
                  {f.path.slice(cut) + (f.dir ? "/" : "")}
                </Text>
                {cut ? (
                  <Text style={styles.slashDesc} numberOfLines={1}>
                    {f.path.slice(0, cut)}
                  </Text>
                ) : null}
              </View>
            </TouchableOpacity>
          )
        })}
      </ScrollView>
    </View>
  )
}
