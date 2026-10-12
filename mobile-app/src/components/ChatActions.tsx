import React, { useEffect, useState } from "react"
import { Text, TextInput, TouchableOpacity, View } from "react-native"
import SheetModal from "./SheetModal"
import { useStyles } from "../lib/styles"

/**
 * Long-press actions for a chat: rename or delete. Delete is confirmed and
 * styled as destructive — a mis-tap here would lose a session transcript.
 */
export default function ChatActions({
  visible,
  name,
  archived,
  favorite,
  onClose,
  onRename,
  onArchive,
  onFavorite,
  onDelete,
  onSelect,
}: {
  visible: boolean
  name: string
  archived?: boolean
  favorite?: boolean
  onClose: () => void
  onRename: (title: string) => void
  onArchive: () => void
  onFavorite: () => void
  onDelete: () => void // confirms over this sheet and closes it on Delete; Cancel keeps it up
  onSelect?: () => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [title, setTitle] = useState(name)

  useEffect(() => {
    if (visible) {
      setRenaming(false)
      setTitle(name)
    }
  }, [visible, name])

  const styles = useStyles()
  return (
    <SheetModal visible={visible} onClose={onClose}>
      <View style={styles.sheetGrabber} />
      <Text style={styles.actionSheetTitle} numberOfLines={1}>
        {name}
      </Text>

      {renaming ? (
        <View style={{ paddingHorizontal: 20, paddingTop: 10 }}>
          <TextInput
            testID="rename-input"
            style={styles.input}
            value={title}
            onChangeText={setTitle}
            autoFocus
            placeholder="Chat name"
          />
          <TouchableOpacity
            testID="rename-save"
            style={[styles.button, !title.trim() ? { opacity: 0.5 } : null]}
            disabled={!title.trim()}
            onPress={() => {
              onRename(title.trim())
              onClose()
            }}
          >
            <Text style={styles.buttonText}>Save name</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          <TouchableOpacity testID="action-rename" style={styles.actionRow} onPress={() => setRenaming(true)}>
            <Text style={styles.actionText}>Rename</Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID="action-favorite"
            style={styles.actionRow}
            onPress={() => {
              onFavorite()
              onClose()
            }}
          >
            <Text style={styles.actionText}>{favorite ? "Unfavorite" : "Favorite"}</Text>
          </TouchableOpacity>
          {onSelect ? (
            <TouchableOpacity
              testID="action-select"
              style={styles.actionRow}
              onPress={() => {
                onSelect()
                onClose()
              }}
            >
              <Text style={styles.actionText}>Select</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity
            testID="action-archive"
            style={styles.actionRow}
            onPress={() => {
              onArchive()
              onClose()
            }}
          >
            <Text style={styles.actionText}>{archived ? "Unarchive" : "Archive"}</Text>
          </TouchableOpacity>
          <TouchableOpacity testID="action-delete" style={styles.actionRow} onPress={onDelete}>
            <Text style={[styles.actionText, styles.actionDanger]}>Delete chat</Text>
          </TouchableOpacity>
        </>
      )}

      <TouchableOpacity style={styles.sheetCancel} onPress={onClose}>
        <Text style={styles.sheetCancelText}>Cancel</Text>
      </TouchableOpacity>
    </SheetModal>
  )
}
