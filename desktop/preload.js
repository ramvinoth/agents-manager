// The only bridge from a page to the main process, and only for the bundled installer
// page (file:). Pages served by Manager never get it, so a web bug cannot reinstall.
"use strict"
const { contextBridge, ipcRenderer } = require("electron")

if (location.protocol === "file:") contextBridge.exposeInMainWorld("agentsDesktop", {
  install: () => ipcRenderer.invoke("agents:install"),
  open: () => ipcRenderer.invoke("agents:open"),
  retry: () => ipcRenderer.invoke("agents:retry"),
  manualCommand: () => ipcRenderer.invoke("agents:manual"),
  onLog: (fn) => ipcRenderer.on("agents:log", (_e, line) => fn(line)),
})
