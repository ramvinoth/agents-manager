// Harman desktop shell: opens the local Harman server, or installs it on first run.
// The server is the product; this app only finds it, starts it, or installs it
// (by running the repo's own deploy/install.sh — there is no second installer).
"use strict"
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain } = require("electron")
const { spawn, execFile } = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const S = require("./src/state")

const home = os.homedir()
const serverDir = path.join(home, ".harman", "server") // stable: the service runs from here
let win = null
let tray = null

async function health() {
  try {
    const r = await fetch(`${S.SERVER_URL}/healthz`, { signal: AbortSignal.timeout(2000) })
    return await r.json()
  } catch {
    return null
  }
}

async function waitForServer(seconds) {
  for (let i = 0; i < seconds; i++) {
    if (S.decide(await health(), false) === "open") return true
    await new Promise((r) => setTimeout(r, 1000))
  }
  return false
}

function installed() {
  const f = S.serviceFile(process.platform, home)
  return !!f && fs.existsSync(f)
}

function window() {
  if (win && !win.isDestroyed()) return win
  win = new BrowserWindow({
    width: 1280, height: 860, title: "Harman",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true,
                      preload: path.join(__dirname, "preload.js") },
  })
  // Links out of the app (docs, OAuth, Stripe…) open in the user's browser, never in here.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(S.SERVER_URL)) shell.openExternal(url)
    return { action: url.startsWith(S.SERVER_URL) ? "allow" : "deny" }
  })
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(S.SERVER_URL) && !url.startsWith("file:")) { e.preventDefault(); shell.openExternal(url) }
  })
  win.on("closed", () => { win = null })
  return win
}

function openHarman(query = "") {
  window().loadURL(`${S.SERVER_URL}/${query}`)
  win.show()
}

function showInstaller(mode) {
  window().loadFile(path.join(__dirname, "install.html"), { query: { mode } })
  win.show()
}

async function launch() {
  const what = S.decide(await health(), installed())
  if (what === "open") return openHarman()
  if (what === "install") return showInstaller(S.canInstallUnattended(process.platform) ? "auto" : "manual")
  showInstaller("starting")
  const start = S.startCommand(process.platform, process.getuid?.())
  if (start) execFile(start[0], start[1], () => {})
  if (await waitForServer(60)) openHarman()
  else showInstaller("down")
}

// ─── First-run install: copy the bundled server out, run deploy/install.sh, stream its log ───
// Every handler answers only the bundled installer page (main enforces what preload hides).
const fromInstaller = (e) => (e.senderFrame?.url || "").startsWith("file:")
const handle = (ch, fn) => ipcMain.handle(ch, (e, ...a) => fromInstaller(e) ? fn(e, ...a) : null)

handle("harman:install", async (e) => {
  const send = (line) => e.sender.send("harman:log", line)
  const bundled = path.join(process.resourcesPath, "server")
  if (!fs.existsSync(path.join(bundled, "deploy", "install.sh"))) {
    send("This build has no server bundled (run `npm run stage` before packaging).")
    return { ok: false }
  }
  fs.mkdirSync(path.dirname(serverDir), { recursive: true })
  fs.cpSync(bundled, serverDir, { recursive: true, force: true })
  send(`Copied the Harman server to ${serverDir}`)
  const env = { ...process.env, PATH: S.guiPath(process.env.PATH, home) }
  const code = await new Promise((resolve) => {
    const p = spawn("bash", [path.join(serverDir, "deploy", "install.sh")], { cwd: serverDir, env })
    p.stdout.on("data", (d) => send(String(d)))
    p.stderr.on("data", (d) => send(String(d)))
    p.on("close", resolve)
    p.on("error", (err) => { send(String(err)); resolve(1) })
  })
  if (code !== 0) return { ok: false }
  const ready = await waitForServer(60)
  let setupCode = null
  try { setupCode = fs.readFileSync(path.join(home, ".harman", "setup-code"), "utf8").trim() } catch {}
  return { ok: ready, setupCode }
})
handle("harman:open", () => openHarman())
handle("harman:retry", () => launch())
handle("harman:manual", () => `bash ${path.join(process.resourcesPath, "server", "deploy", "install.sh")}`)

function buildTray() {
  tray = new Tray(nativeImage.createEmpty())
  tray.setTitle("H")
  tray.setToolTip("Harman")
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Harman", click: () => launch() },
    { label: "Pair a phone…", click: () => openHarman("?pair=1") },
    { type: "separator" },
    { label: "Quit", role: "quit" },
  ]))
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on("second-instance", () => launch())
  app.whenReady().then(() => { buildTray(); launch() })
  app.on("activate", () => launch())
  // The server keeps running as a service; closing the window just hides the app.
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit() })
}
