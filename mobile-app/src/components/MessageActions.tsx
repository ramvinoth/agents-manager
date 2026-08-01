import React from "react"
import { Text, TouchableOpacity, View } from "react-native"
import Icon from "./Icon"
import SheetModal from "./SheetModal"
import { useTheme } from "../lib/useTheme"
import { useStyles } from "../screens/styles"

export type MsgTarget = { uuid?: string; text: string; isUser: boolean }

/**
 * Long-press actions on a message. Copy and Reply apply to any message; Fork and
 * Revert need a transcript uuid, so they only appear for real (non-optimistic)
 * messages. Revert is destructive and confirmed by the caller.
 */
export default function MessageActions({
  target,
  onClose,
  onReply,
  onCopy,
  onFork,
  onRevert,
  pinned,
  onPin,
}: {
  target: MsgTarget | null
  onClose: () => void
  onReply: () => void
  onCopy: () => void
  onFork: () => void
  onRevert: () => void
  pinned?: boolean
  onPin: () => void
}) {
  const styles = useStyles()
  const t = useTheme()
  if (!target) return null
  const canCut = !!target.uuid
  const row = [styles.actionRow, { flexDirection: "row" as const, alignItems: "center" as const, gap: 10 }]
  return (
    <SheetModal visible onClose={onClose}>
      <View style={styles.sheetGrabber} />
      <Text style={styles.actionSheetTitle} numberOfLines={2}>
        {target.text || "(no text)"}
      </Text>

      <TouchableOpacity testID="msg-reply" style={row} onPress={onReply}>
        <Icon name="reply" size={18} color={t.text} />
        <Text style={styles.actionText}>Reply</Text>
      </TouchableOpacity>
      <TouchableOpacity testID="msg-copy" style={row} onPress={onCopy}>
        <Icon name="copy" size={18} color={t.text} />
        <Text style={styles.actionText}>Copy text</Text>
      </TouchableOpacity>

      {canCut ? (
        <>
          <TouchableOpacity testID="msg-pin" style={row} onPress={onPin}>
            <Icon name="pin" size={18} color={t.accent} />
            <Text style={styles.actionText}>{pinned ? "Unpin" : "Pin"}</Text>
          </TouchableOpacity>
          <TouchableOpacity testID="msg-fork" style={row} onPress={onFork}>
            <Icon name="fork" size={18} color={t.text} />
            <Text style={styles.actionText}>Fork into new chat</Text>
          </TouchableOpacity>
          <TouchableOpacity testID="msg-revert" style={row} onPress={onRevert}>
            <Icon name="revert" size={18} color={t.danger} />
            <Text style={[styles.actionText, styles.actionDanger]}>Revert to here</Text>
          </TouchableOpacity>
        </>
      ) : null}

      <TouchableOpacity style={styles.sheetCancel} onPress={onClose}>
        <Text style={styles.sheetCancelText}>Cancel</Text>
      </TouchableOpacity>
    </SheetModal>
  )
}
