import { Platform } from "react-native"

/** The platform's monospace face, for code, paths and ids. */
export const MONO_FONT = Platform.OS === "ios" ? "Menlo" : "monospace"
