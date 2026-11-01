// The only bridge from a page to the main process, and only for the bundled installer
// page (file:). Pages served by Harman never get it, so a web bug cannot reinstall.
"use strict"
const { contextBridge, ipcRenderer } = require("electron")

if (location.protocol === "file:") contextBridge.exposeInMainWorld("harmanDesktop", {
  install: () => ipcRenderer.invoke("harman:install"),
  open: () => ipcRenderer.invoke("harman:open"),
  retry: () => ipcRenderer.invoke("harman:retry"),
  manualCommand: () => ipcRenderer.invoke("harman:manual"),
  onLog: (fn) => ipcRenderer.on("harman:log", (_e, line) => fn(line)),
})
