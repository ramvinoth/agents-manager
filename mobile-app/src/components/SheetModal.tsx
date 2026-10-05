import React, { useEffect, useRef } from "react"
import { Animated, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet } from "react-native"
import { useStyles } from "../screens/styles"

/**
 * A bottom sheet with the correct backdrop behaviour: the dark scrim FADES in
 * place while only the sheet SLIDES up from the bottom. React Native's built-in
 * `animationType="slide"` slides the entire modal — scrim included — so the
 * backdrop appears to sweep up from the bottom edge as a moving "film". Driving
 * the two independently (opacity for the scrim, translateY for the sheet) gives
 * the standard iOS action-sheet feel.
 *
 * Children are the sheet body; this component supplies the scrim + slide + the
 * tap-outside-to-close behaviour, so callers just render their rows. The
 * sheet rides up above the keyboard, so a sheet with a text field never hides
 * its own Save button.
 */
export default function SheetModal({
  visible,
  onClose,
  children,
}: {
  visible: boolean
  onClose: () => void
  children: React.ReactNode
}) {
  const styles = useStyles()
  const anim = useRef(new Animated.Value(0)).current // 0 = hidden, 1 = shown

  useEffect(() => {
    Animated.timing(anim, {
      toValue: visible ? 1 : 0,
      duration: visible ? 220 : 160,
      useNativeDriver: true,
    }).start()
  }, [visible, anim])

  const translateY = anim.interpolate({ inputRange: [0, 1], outputRange: [600, 0] })

  return (
    <Modal transparent visible={visible} animationType="none" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        {/* accessible={false} on both Pressables: an accessible Pressable folds its
            subtree into one element, hiding every row of the sheet from
            VoiceOver and XCUITest. */}
        <Pressable accessible={false} style={{ flex: 1, justifyContent: "flex-end" }} onPress={onClose}>
          {/* Scrim: fades in place (opacity only), never slides. */}
          <Animated.View
            style={[StyleSheet.absoluteFillObject, { backgroundColor: "rgba(0,0,0,0.45)", opacity: anim }]}
            pointerEvents="none"
          />
          {/* Sheet: slides up; stop propagation so taps inside don't close. */}
          <Animated.View style={{ transform: [{ translateY }] }}>
            <Pressable accessible={false} style={styles.sheet} onPress={(e) => e.stopPropagation()}>
              {children}
            </Pressable>
          </Animated.View>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  )
}
