import React, { useEffect, useState } from "react"
import { AppState, Text, TouchableOpacity, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { undoQueue, type UndoAction } from "../lib/undo"
import { useStyles } from "../lib/styles"

/** The single app-wide Undo bar (card 153); mounted once in App.tsx, fed by offerUndo(). */
export default function UndoToast() {
  const styles = useStyles()
  const insets = useSafeAreaInsets()
  const [action, setAction] = useState<UndoAction | null>(undoQueue.current())
  useEffect(() => undoQueue.subscribe(setAction), [])
  // Leaving the app commits a pending action rather than risk the OS killing it unsent.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => { if (s !== "active") undoQueue.flush() })
    return () => sub.remove()
  }, [])
  if (!action) return null
  // Sits above the bottom tab bar (~56pt) so it never covers navigation.
  return (
    <View pointerEvents="box-none" style={[styles.undoWrap, { bottom: insets.bottom + 64 }]}>
      <View testID="undo-toast" accessibilityLiveRegion="polite" style={styles.undoBar}>
        <Text testID="undo-label" numberOfLines={1} style={styles.undoLabel}>{action.label}</Text>
        <TouchableOpacity testID="undo-button" accessibilityLabel="Undo" hitSlop={10} onPress={() => undoQueue.undo()}>
          <Text style={styles.undoButton}>Undo</Text>
        </TouchableOpacity>
      </View>
    </View>
  )
}
