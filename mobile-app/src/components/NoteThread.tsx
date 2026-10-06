import React, { useCallback, useEffect, useState } from "react"
import { ActivityIndicator, Text, TextInput, TouchableOpacity, View } from "react-native"
import { api, type NoteComment, type NoteCommentSort } from "../api/client"
import { formatActor } from "../lib/board"
import { userError } from "../lib/errors"
import { username } from "../state/config"
import { useTheme } from "../lib/useTheme"
import Markdown from "./Markdown"

const SORTS: { key: NoteCommentSort; label: string }[] = [
  { key: "best", label: "Best" }, { key: "new", label: "New" }, { key: "old", label: "Old" },
]

/**
 * NoteThread — the discussion under a note (viewer/discussion): sessions and
 * the owner reply in nested threads and vote so the best answer rises. The
 * server nests, sorts and wakes the agents a reply concerns; this only renders
 * and writes. Mirrors web/src/components/notes/NoteThread.tsx.
 */
export default function NoteThread({ noteId }: { noteId: number }) {
  const t = useTheme()
  const [comments, setComments] = useState<NoteComment[]>([])
  const [count, setCount] = useState(0)
  const [sort, setSort] = useState<NoteCommentSort>("best")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const r = await api.orgNoteComments(noteId, sort)
      setComments(r.comments); setCount(r.count); setError("")
    } catch (e) {
      setError(userError(e, "load the discussion"))
    } finally {
      setLoading(false)
    }
  }, [noteId, sort])
  useEffect(() => { void load() }, [load])

  const post = async (body: string, parentId: number | null) => {
    await api.orgNoteComment({ note_id: noteId, body, parent_id: parentId })
    await load()
  }
  const vote = async (c: NoteComment, value: -1 | 1) => {
    try { await api.orgNoteVote(c.id, c.my_vote === value ? 0 : value); await load() }
    catch (e) { setError(userError(e, "vote")) }
  }

  return (
    <View testID="note-thread" style={{ marginTop: 24, borderTopWidth: 1, borderTopColor: t.border, paddingTop: 12, gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Text style={{ color: t.textMuted, fontSize: 12, fontWeight: "600", flex: 1 }}>DISCUSSION{count ? ` · ${count}` : ""}</Text>
        {SORTS.map((s) => (
          <TouchableOpacity key={s.key} testID={`thread-sort-${s.key}`} onPress={() => setSort(s.key)}
            style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, backgroundColor: sort === s.key ? t.chipBg : "transparent" }}>
            <Text style={{ fontSize: 12, color: sort === s.key ? t.text : t.textMuted }}>{s.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <Composer testID="thread-composer" placeholder="Start or join the discussion" onSubmit={(b) => post(b, null)} />
      {loading ? <ActivityIndicator color={t.accent} />
        : error ? (
          <TouchableOpacity onPress={() => { setLoading(true); void load() }}>
            <Text style={{ color: t.danger, fontSize: 13 }}>{error} · Try again</Text>
          </TouchableOpacity>
        ) : comments.length === 0 ? <Text style={{ color: t.textMuted, fontSize: 13 }}>No replies yet.</Text>
        : comments.map((c) => <Comment key={c.id} c={c} depth={0} onReply={post} onVote={vote} />)}
    </View>
  )
}

function Comment({ c, depth, onReply, onVote }: {
  c: NoteComment; depth: number
  onReply: (body: string, parentId: number) => Promise<void>
  onVote: (c: NoteComment, v: -1 | 1) => Promise<void>
}) {
  const t = useTheme()
  const who = formatActor(c.author, username())
  const own = who.kind === "you"
  const [replying, setReplying] = useState(false)
  // Nesting is capped visually: past a few levels a phone has no width left.
  const indent = depth > 0 && depth < 4
  return (
    <View testID={`comment-${c.id}`} style={indent ? { marginLeft: 10, paddingLeft: 10, borderLeftWidth: 2, borderLeftColor: t.border } : undefined}>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ alignItems: "center", width: 24 }}>
          <TouchableOpacity testID={`vote-up-${c.id}`} disabled={own} onPress={() => void onVote(c, 1)} hitSlop={6} accessibilityLabel="Agree">
            <Text style={{ color: c.my_vote === 1 ? t.accent : t.textMuted, opacity: own ? 0.3 : 1 }}>▲</Text>
          </TouchableOpacity>
          <Text style={{ fontSize: 12, color: c.score > 0 ? t.accent : c.score < 0 ? t.danger : t.textMuted }}>{c.score}</Text>
          <TouchableOpacity testID={`vote-down-${c.id}`} disabled={own} onPress={() => void onVote(c, -1)} hitSlop={6} accessibilityLabel="Disagree">
            <Text style={{ color: c.my_vote === -1 ? t.danger : t.textMuted, opacity: own ? 0.3 : 1 }}>▼</Text>
          </TouchableOpacity>
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ color: t.textMuted, fontSize: 12 }}>
            <Text style={{ color: t.text, fontWeight: "600" }}>{own ? "you" : who.name}</Text>
            {who.kind === "agent" ? " · agent" : ""} · {new Date(c.created_at * 1000).toLocaleString()}
          </Text>
          <Markdown text={c.body} color={t.text} selectable />
          <TouchableOpacity testID={`reply-${c.id}`} onPress={() => setReplying(!replying)} hitSlop={6}>
            <Text style={{ color: t.textMuted, fontSize: 12, fontWeight: "600" }}>{replying ? "Cancel" : "Reply"}</Text>
          </TouchableOpacity>
          {replying ? (
            <Composer testID={`reply-composer-${c.id}`} autoFocus placeholder={`Reply to ${own ? "yourself" : who.name}`}
              onSubmit={async (b) => { await onReply(b, c.id); setReplying(false) }} />
          ) : null}
        </View>
      </View>
      {c.replies.map((r) => <View key={r.id} style={{ marginTop: 8 }}><Comment c={r} depth={depth + 1} onReply={onReply} onVote={onVote} /></View>)}
    </View>
  )
}

function Composer({ placeholder, autoFocus, testID, onSubmit }: { placeholder: string; autoFocus?: boolean; testID: string; onSubmit: (body: string) => Promise<void> }) {
  const t = useTheme()
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const send = async () => {
    if (!text.trim() || busy) return
    setBusy(true); setError("")
    try { await onSubmit(text.trim()); setText("") } catch (e) { setError(userError(e, "post")) } finally { setBusy(false) }
  }
  return (
    <View style={{ gap: 4, marginTop: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
        <TextInput testID={testID} value={text} onChangeText={setText} placeholder={placeholder} placeholderTextColor={t.textMuted}
          autoFocus={autoFocus} multiline
          style={{ flex: 1, color: t.text, fontSize: 15, borderWidth: 1, borderColor: t.border, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, maxHeight: 140 }} />
        <TouchableOpacity testID={`${testID}-post`} disabled={!text.trim() || busy} onPress={() => void send()}
          style={{ paddingHorizontal: 14, paddingVertical: 9, borderRadius: 10, backgroundColor: text.trim() ? t.accent : t.chipBg }}>
          {busy ? <ActivityIndicator size="small" color={t.onAccent} />
            : <Text style={{ color: text.trim() ? t.onAccent : t.textMuted, fontWeight: "600" }}>Post</Text>}
        </TouchableOpacity>
      </View>
      {error ? <Text style={{ color: t.danger, fontSize: 12 }}>{error}</Text> : null}
    </View>
  )
}
