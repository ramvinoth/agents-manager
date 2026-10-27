import React, { useCallback, useEffect, useState } from "react"
import { ActivityIndicator, Text, TextInput, TouchableOpacity, View } from "react-native"
import { api, type NoteComment, type NoteCommentSort } from "../api/client"
import { formatActor } from "../lib/board"
import { userError } from "../lib/errors"
import { username } from "../state/config"
import { useTheme } from "../lib/useTheme"
import { useStyles } from "../lib/styles"
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
  const styles = useStyles()
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
    <View testID="note-thread" style={styles.ntWrap}>
      <View style={styles.ntHeader}>
        <Text style={styles.ntTitle}>DISCUSSION{count ? ` · ${count}` : ""}</Text>
        {SORTS.map((s) => (
          <TouchableOpacity key={s.key} testID={`thread-sort-${s.key}`} onPress={() => setSort(s.key)}
            style={[styles.ntSort, sort === s.key ? styles.ntSortActive : null]}>
            <Text style={[styles.ntSortText, sort === s.key ? styles.ntSortTextActive : null]}>{s.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <Composer testID="thread-composer" placeholder="Start or join the discussion" onSubmit={(b) => post(b, null)} />
      {loading ? <ActivityIndicator color={t.accent} />
        : error ? (
          <TouchableOpacity onPress={() => { setLoading(true); void load() }}>
            <Text style={styles.ntError}>{error} · Try again</Text>
          </TouchableOpacity>
        ) : comments.length === 0 ? <Text style={styles.ntEmpty}>No replies yet.</Text>
        : comments.map((c) => <Comment key={c.id} c={c} depth={0} onReply={post} onVote={vote} />)}
    </View>
  )
}

function Comment({ c, depth, onReply, onVote }: {
  c: NoteComment; depth: number
  onReply: (body: string, parentId: number) => Promise<void>
  onVote: (c: NoteComment, v: -1 | 1) => Promise<void>
}) {
  const styles = useStyles()
  const t = useTheme()
  const who = formatActor(c.author, username())
  const own = who.kind === "you"
  const [replying, setReplying] = useState(false)
  // Nesting is capped visually: past a few levels a phone has no width left.
  const indent = depth > 0 && depth < 4
  return (
    <View testID={`comment-${c.id}`} style={indent ? styles.ntIndent : undefined}>
      <View style={styles.ntComment}>
        <View style={styles.ntVotes}>
          <TouchableOpacity testID={`vote-up-${c.id}`} disabled={own} onPress={() => void onVote(c, 1)} hitSlop={6} accessibilityLabel="Agree">
            <Text style={[styles.ntVote, c.my_vote === 1 ? styles.ntVoteUp : null, own ? styles.ntVoteOwn : null]}>▲</Text>
          </TouchableOpacity>
          <Text style={[styles.ntScore, c.score > 0 ? styles.ntVoteUp : c.score < 0 ? styles.ntVoteDown : null]}>{c.score}</Text>
          <TouchableOpacity testID={`vote-down-${c.id}`} disabled={own} onPress={() => void onVote(c, -1)} hitSlop={6} accessibilityLabel="Disagree">
            <Text style={[styles.ntVote, c.my_vote === -1 ? styles.ntVoteDown : null, own ? styles.ntVoteOwn : null]}>▼</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.ntBody}>
          <Text style={styles.ntMeta}>
            <Text style={styles.ntAuthor}>{own ? "you" : who.name}</Text>
            {who.kind === "agent" ? " · agent" : ""} · {new Date(c.created_at * 1000).toLocaleString()}
          </Text>
          <Markdown text={c.body} color={t.text} selectable />
          <TouchableOpacity testID={`reply-${c.id}`} onPress={() => setReplying(!replying)} hitSlop={6}>
            <Text style={styles.ntReply}>{replying ? "Cancel" : "Reply"}</Text>
          </TouchableOpacity>
          {replying ? (
            <Composer testID={`reply-composer-${c.id}`} autoFocus placeholder={`Reply to ${own ? "yourself" : who.name}`}
              onSubmit={async (b) => { await onReply(b, c.id); setReplying(false) }} />
          ) : null}
        </View>
      </View>
      {c.replies.map((r) => <View key={r.id} style={styles.ntChild}><Comment c={r} depth={depth + 1} onReply={onReply} onVote={onVote} /></View>)}
    </View>
  )
}

function Composer({ placeholder, autoFocus, testID, onSubmit }: { placeholder: string; autoFocus?: boolean; testID: string; onSubmit: (body: string) => Promise<void> }) {
  const styles = useStyles()
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
    <View style={styles.ntComposer}>
      <View style={styles.ntComposerRow}>
        <TextInput testID={testID} value={text} onChangeText={setText} placeholder={placeholder} placeholderTextColor={t.textMuted}
          autoFocus={autoFocus} multiline
          style={styles.ntInput} />
        <TouchableOpacity testID={`${testID}-post`} disabled={!text.trim() || busy} onPress={() => void send()}
          style={[styles.ntPost, text.trim() ? styles.ntPostReady : null]}>
          {busy ? <ActivityIndicator size="small" color={t.onAccent} />
            : <Text style={[styles.ntPostText, text.trim() ? styles.ntPostTextReady : null]}>Post</Text>}
        </TouchableOpacity>
      </View>
      {error ? <Text style={styles.ntComposerError}>{error}</Text> : null}
    </View>
  )
}
