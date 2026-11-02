// The phone-call feature is iOS-only (CallKit, see src/lib/callManager.ts), so
// react-native-callkeep is not linked into the Android build. Its JS still loads
// there; callManager never calls into it off iOS.
module.exports = {
  dependencies: {
    "react-native-callkeep": {
      platforms: { android: null },
    },
  },
}
