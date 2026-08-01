import React from "react"
import { Ionicons } from "@expo/vector-icons"

/**
 * The app's icon set. Everything routes through here so icons stay consistent
 * and are real vector glyphs rather than emoji — emoji render differently per
 * platform/OS version, can't be tinted, and look unprofessional in a product UI.
 *
 * @expo/vector-icons ships with the Expo SDK, so this adds no native dependency.
 */
export type IconName =
  | "menu"
  | "add"
  | "settings"
  | "attach"
  | "send"
  | "stop"
  | "info"
  | "reply"
  | "copy"
  | "fork"
  | "revert"
  | "folder"
  | "file"
  | "up"
  | "close"
  | "tool"
  | "warning"
  | "chevronDown"
  | "chevronRight"
  | "check"
  | "flash"
  | "clock"
  | "help"
  | "search"
  | "user"
  | "sparkle"
  | "terminal"
  | "repeat"
  | "trash"
  | "chat"
  | "server"
  | "chatFilled"
  | "serverFilled"
  | "folderFilled"
  | "userFilled"
  | "folderPlus"
  | "upload"
  | "sun"
  | "moon"
  | "archive"
  | "star"
  | "starOutline"
  | "chevronLeft"
  | "pin"
  | "mic"
  | "micOff"
  | "volume"

const MAP: Record<IconName, keyof typeof Ionicons.glyphMap> = {
  menu: "menu",
  add: "create-outline",
  settings: "options-outline",
  attach: "image-outline",
  send: "arrow-up",
  stop: "stop",
  info: "information-circle-outline",
  reply: "arrow-undo-outline",
  copy: "copy-outline",
  fork: "git-branch-outline",
  revert: "play-back-outline",
  folder: "folder",
  file: "document-outline",
  up: "arrow-up-outline",
  close: "close",
  tool: "construct-outline",
  warning: "warning-outline",
  chevronDown: "chevron-down",
  chevronRight: "chevron-forward",
  check: "checkmark",
  flash: "flash-outline",
  clock: "time-outline",
  help: "help-circle-outline",
  search: "search",
  user: "person-outline",
  sparkle: "sparkles-outline",
  terminal: "terminal-outline",
  repeat: "repeat",
  trash: "trash-outline",
  chat: "chatbubbles-outline",
  server: "server-outline",
  chatFilled: "chatbubbles",
  serverFilled: "server",
  folderFilled: "folder",
  userFilled: "person",
  folderPlus: "folder-open-outline",
  upload: "cloud-upload-outline",
  sun: "sunny-outline",
  moon: "moon-outline",
  archive: "archive-outline",
  star: "star",
  starOutline: "star-outline",
  chevronLeft: "chevron-back",
  pin: "pin",
  mic: "mic",
  micOff: "mic-off",
  volume: "volume-high-outline",
}

export default function Icon({
  name,
  size = 20,
  color = "#333",
}: {
  name: IconName
  size?: number
  color?: string
}) {
  return <Ionicons name={MAP[name]} size={size} color={color} />
}
