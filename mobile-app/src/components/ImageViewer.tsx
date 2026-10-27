import React from "react"
import { Image, Modal, Pressable, ScrollView, Text, View, useWindowDimensions } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useTheme } from "../lib/useTheme"

/**
 * Full-screen image (a screenshot a tool returned, an attached photo): pinch to
 * zoom up to 8x, drag to pan. iOS ScrollView zooming does the gestures natively,
 * so there is no gesture maths here. Mounted only while open.
 */
export default function ImageViewer({ uri, onClose }: { uri: string; onClose: () => void }) {
  const t = useTheme()
  const insets = useSafeAreaInsets()
  const { width, height } = useWindowDimensions()
  const stageH = height - insets.top - insets.bottom - 44
  return (
    <Modal visible animationType="fade" onRequestClose={onClose} supportedOrientations={["portrait", "landscape"]}>
      <View style={{ flex: 1, backgroundColor: "#000", paddingTop: insets.top, paddingBottom: insets.bottom }}>
        <View style={{ height: 44, flexDirection: "row", alignItems: "center", paddingHorizontal: 16 }}>
          <Text style={{ flex: 1, fontSize: 13, color: "#a1a1aa" }}>Pinch to zoom · drag to move</Text>
          <Pressable testID="image-viewer-close" onPress={onClose} hitSlop={12}>
            <Text style={{ fontSize: 16, fontWeight: "600", color: t.accent }}>Done</Text>
          </Pressable>
        </View>
        <ScrollView
          testID="image-viewer"
          maximumZoomScale={8}
          minimumZoomScale={1}
          centerContent
          bouncesZoom
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
        >
          <Image source={{ uri }} style={{ width, height: stageH }} resizeMode="contain" />
        </ScrollView>
      </View>
    </Modal>
  )
}
