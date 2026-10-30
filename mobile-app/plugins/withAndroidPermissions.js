/**
 * withAndroidPermissions — keep the Android manifest to the permissions the app
 * actually uses, so Google Play has nothing to flag.
 *
 * Why each removal is safe:
 *  - The phone-call feature is iOS-only (CallKit; src/lib/callManager.ts returns
 *    early unless Platform.OS === "ios"). @config-plugins/react-native-callkeep
 *    still adds its Android telecom permissions and two exported services, and
 *    react-native.config.js keeps the callkeep library out of the Android build,
 *    so those services would point at classes that aren't there. CALL_PHONE and
 *    READ_PHONE_STATE are Play "sensitive" permissions, and a phoneCall
 *    foreground service needs a Play declaration — none of it is used.
 *  - Photos are picked with the system photo picker (expo-image-picker uses
 *    PickVisualMedia), which needs no storage or media permission. Play's photo
 *    and video policy rejects READ_MEDIA_* for occasional picking.
 *  - SYSTEM_ALERT_WINDOW is only for the dev menu overlay.
 *
 * Library manifests (expo-image-picker, callkeep) also declare some of these
 * permissions, so each is written as tools:node="remove", which strips it from
 * the merged manifest too, not just from the app's own.
 */
const { withAndroidManifest, AndroidConfig } = require("expo/config-plugins")

const REMOVED_PERMISSIONS = [
  // callkeep (Android call integration we don't use)
  "android.permission.BIND_TELECOM_CONNECTION_SERVICE",
  "android.permission.CALL_PHONE",
  "android.permission.READ_PHONE_STATE",
  "android.permission.READ_PHONE_NUMBERS",
  "android.permission.MANAGE_OWN_CALLS",
  "android.permission.FOREGROUND_SERVICE",
  // storage / media (the photo picker needs none of these)
  "android.permission.READ_EXTERNAL_STORAGE",
  "android.permission.WRITE_EXTERNAL_STORAGE",
  "android.permission.READ_MEDIA_IMAGES",
  "android.permission.READ_MEDIA_VIDEO",
  // dev-menu overlay
  "android.permission.SYSTEM_ALERT_WINDOW",
]

const CALLKEEP_SERVICES = [
  "io.wazo.callkeep.RNCallKeepBackgroundMessagingService",
  "io.wazo.callkeep.VoiceConnectionService",
]

module.exports = function withAndroidPermissions(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest
    manifest.$ = { ...manifest.$, "xmlns:tools": "http://schemas.android.com/tools" }

    const kept = (manifest["uses-permission"] || []).filter(
      (p) => !REMOVED_PERMISSIONS.includes(p.$["android:name"])
    )
    manifest["uses-permission"] = [
      ...kept,
      ...REMOVED_PERMISSIONS.map((name) => ({ $: { "android:name": name, "tools:node": "remove" } })),
    ]

    // Same for callkeep's services. A removal marker (rather than just dropping
    // the element) also stops the callkeep plugin re-adding them: it only adds a
    // service whose name isn't already there, whichever plugin's mod runs first.
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(config.modResults)
    app.service = [
      ...(app.service || []).filter((s) => !CALLKEEP_SERVICES.includes(s.$["android:name"])),
      ...CALLKEEP_SERVICES.map((name) => ({ $: { "android:name": name, "tools:node": "remove" } })),
    ]
    return config
  })
}
