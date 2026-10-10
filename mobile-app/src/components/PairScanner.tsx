import React, { useRef, useState } from "react"
import { Linking, Modal, Text, TouchableOpacity, View } from "react-native"
import { CameraView, useCameraPermissions } from "expo-camera"
import { parsePairLink } from "../lib/pairLink"
import { useStyles } from "../lib/styles"
import { useTheme } from "../lib/useTheme"

/**
 * Full-screen camera that reads the pairing QR (web Profile → Pair a phone)
 * inside the app — the iPhone Camera path still works, but people look for the
 * scanner here first (Paseo does the same: packages/app/src/app/pair-scan.tsx).
 * It only recognises a pairing link and hands the raw text to `onScan`; the
 * caller redeems it through state/signin pairFromLink, the one pairing path.
 */
export default function PairScanner({ visible, onClose, onScan }: {
  visible: boolean
  onClose: () => void
  onScan: (link: string) => void
}) {
  const styles = useStyles()
  const t = useTheme()
  const [permission, requestPermission] = useCameraPermissions()
  const [notPairing, setNotPairing] = useState(false)
  // The camera reports the same code many times a second; take the first one.
  const taken = useRef(false)

  function handle({ data }: { data: string }) {
    if (taken.current) return
    if (!parsePairLink(data)) { setNotPairing(true); return }
    taken.current = true
    onScan(data)
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}
      onShow={() => { taken.current = false; setNotPairing(false) }}>
      <View style={{ flex: 1, backgroundColor: "#000" }}>
        {permission?.granted ? (
          <CameraView testID="pair-camera" style={{ flex: 1 }} facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={handle} />
        ) : (
          <View style={[styles.center, { padding: 24, backgroundColor: "#000" }]}>
            <Text style={{ color: "#fff", textAlign: "center", marginBottom: 16 }}>
              {permission && !permission.canAskAgain
                ? "Camera access is off for Harman. Turn it on in Settings to scan."
                : "Harman needs the camera to scan the pairing code."}
            </Text>
            <TouchableOpacity testID="pair-camera-allow" style={[styles.button, { paddingHorizontal: 24 }]}
              onPress={() => (permission && !permission.canAskAgain ? Linking.openSettings() : requestPermission())}>
              <Text style={styles.buttonText}>{permission && !permission.canAskAgain ? "Open Settings" : "Allow camera"}</Text>
            </TouchableOpacity>
          </View>
        )}
        <View style={{ position: "absolute", left: 0, right: 0, bottom: 48, alignItems: "center", paddingHorizontal: 24 }}>
          <Text style={{ color: "#fff", textAlign: "center", marginBottom: 16 }}>
            {notPairing ? "That isn't a Harman pairing code." : "On your computer: Profile → Pair a phone"}
          </Text>
          <TouchableOpacity testID="pair-scan-cancel" accessibilityLabel="Cancel scan" onPress={onClose}
            style={{ paddingVertical: 12, paddingHorizontal: 28, borderRadius: 24, backgroundColor: "rgba(255,255,255,0.2)" }}>
            <Text style={{ color: "#fff", fontWeight: "600" }}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  )
}
