// Pure decisions for the desktop shell — no Electron, no I/O — so node:test covers them.
"use strict"
const path = require("node:path")

const PORT = 8091
const SERVER_URL = `http://127.0.0.1:${PORT}`

// What the app does on launch, from /healthz (parsed JSON, or null when nothing answered)
// and whether the platform service is installed.
//   open    — a server answers: show it (it renders its own DB/auth errors).
//   start   — installed but down: start the service and wait for it.
//   install — never installed here: run the first-run installer.
function decide(health, installed) {
  if (health && typeof health === "object" && "ok" in health) return "open"
  return installed ? "start" : "install"
}

// Where the platform's service definition lives once deploy/install.sh has run.
function serviceFile(platform, home) {
  if (platform === "darwin") return path.join(home, "Library/LaunchAgents/com.harman.viewer.plist")
  if (platform === "linux") return "/etc/systemd/system/harman-viewer.service"
  return null
}

// Starts an installed-but-stopped service. Never `kickstart -k`: that would kill a
// running server and every agent turn it hosts.
function startCommand(platform, uid) {
  if (platform === "darwin") return ["launchctl", ["kickstart", `gui/${uid}/com.harman.viewer`]]
  if (platform === "linux") return ["systemctl", ["start", "harman-viewer.service"]]
  return null
}

// GUI apps on macOS inherit launchd's bare PATH, so Homebrew, node and the claude
// CLI are invisible to the installer unless their dirs are put back.
function guiPath(current, home) {
  const extra = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", path.join(home, ".local/bin")]
  const seen = new Set()
  return [...extra, ...(current || "").split(":")]
    .filter((d) => d && !seen.has(d) && seen.add(d))
    .join(":")
}

// The installer runs unattended only where it needs no password: macOS (Homebrew
// refuses root). Linux installs with apt/sudo, so the app shows the command to run.
function canInstallUnattended(platform) {
  return platform === "darwin"
}

module.exports = { PORT, SERVER_URL, decide, serviceFile, startCommand, guiPath, canInstallUnattended }
