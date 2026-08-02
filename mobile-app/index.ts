// Must be the very first import — react-native-gesture-handler requires this
// at the entry point so its native handlers (used by the swipeable tabs) work.
import "react-native-gesture-handler"
import { registerRootComponent } from "expo"
import App from "./App"

registerRootComponent(App)
