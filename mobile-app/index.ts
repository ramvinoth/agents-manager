// Must be the very first import — react-native-gesture-handler requires this
// at the entry point so its native handlers (used by the swipeable tabs) work.
import "react-native-gesture-handler"
import { registerRootComponent } from "expo"
import TrackPlayer from "react-native-track-player"
import App from "./App"

registerRootComponent(App)

// react-native-track-player requires a playback service registered at the entry
// point. We only stream TTS replies (no lock-screen controls needed), so this is
// an empty service — its presence is what stops the native side from throwing.
TrackPlayer.registerPlaybackService(() => async () => {})
