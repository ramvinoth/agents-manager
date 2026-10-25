import React, { useEffect, useRef, useState } from "react"
import { Text, TouchableOpacity, View } from "react-native"
import SheetModal from "./SheetModal"
import { actionSheetQueue, type SheetAction, type SheetRequest } from "../lib/actionSheet"
import { useStyles } from "../lib/styles"

/** The single app-wide action sheet; mounted once in App.tsx, fed by showActions(). */
export default function ActionSheetHost() {
  const styles = useStyles()
  const [open, setOpen] = useState<SheetRequest | null>(actionSheetQueue.current())
  // The last request stays rendered through the slide-out so the rows don't blank mid-animation.
  const [shown, setShown] = useState<SheetRequest | null>(open)
  // The chosen action runs only once the sheet's Modal is gone: an action that
  // opens its own Modal (Edit job) would otherwise present under a dismissing one.
  const pending = useRef<SheetAction | null>(null)
  useEffect(() => actionSheetQueue.subscribe((r) => { setOpen(r); if (r) setShown(r) }), [])

  const choose = (i: number | null) => { pending.current = actionSheetQueue.close(i) }
  const closed = () => { const a = pending.current; pending.current = null; a?.onPress() }

  return (
    <SheetModal visible={!!open} onClose={() => choose(null)} onClosed={closed}>
      <View testID="action-sheet">
        <View style={styles.sheetGrabber} />
        <Text style={styles.actionSheetTitle} numberOfLines={2}>{shown?.title}</Text>
        {shown?.actions.map((a, i) => (
          <TouchableOpacity key={`${i}-${a.text}`} testID={a.text} accessibilityRole="button" accessibilityLabel={a.text}
            onPress={() => choose(i)}
            style={[styles.actionRow, i === 0 && { borderTopWidth: 0 }]}>
            <Text style={[styles.actionText, a.destructive && styles.actionDanger]}>{a.text}</Text>
          </TouchableOpacity>
        ))}
        <TouchableOpacity testID="Cancel" accessibilityRole="button" accessibilityLabel="Cancel" onPress={() => choose(null)} style={styles.sheetCancel}>
          <Text style={styles.sheetCancelText}>Cancel</Text>
        </TouchableOpacity>
      </View>
    </SheetModal>
  )
}
