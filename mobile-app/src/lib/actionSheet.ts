// One way to show a short list of actions: the native bottom sheet on iOS
// (thumb-reachable, titled with what it acts on), a titled Alert on Android.
// Replaces the blank-title Alert.alert("", "") menus that read like errors.
import { ActionSheetIOS, Alert, Platform } from "react-native"

export type SheetAction = { text: string; onPress: () => void; destructive?: boolean }

export function showActions(title: string, actions: SheetAction[]) {
  if (Platform.OS === "ios") {
    const options = [...actions.map((a) => a.text), "Cancel"]
    const destructiveButtonIndex = actions.map((a, i) => (a.destructive ? i : -1)).filter((i) => i >= 0)
    ActionSheetIOS.showActionSheetWithOptions(
      { title, options, cancelButtonIndex: actions.length, destructiveButtonIndex },
      (i) => { if (i < actions.length) actions[i].onPress() },
    )
    return
  }
  Alert.alert(title, undefined, [
    ...actions.map((a) => ({ text: a.text, onPress: a.onPress, style: a.destructive ? ("destructive" as const) : undefined })),
    { text: "Cancel", style: "cancel" as const },
  ])
}
