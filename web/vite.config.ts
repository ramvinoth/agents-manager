import fs from "fs"
import path from "path"
import { defineConfig, type Plugin } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

// Excalidraw loads its fonts from window.EXCALIDRAW_ASSET_PATH (set in
// CanvasDialog). Copy them out of node_modules at build time so a self-hosted
// box never depends on a public CDN, and the repo never carries 13 MB of fonts.
function excalidrawAssets(): Plugin {
  return {
    name: "excalidraw-assets",
    apply: "build",
    closeBundle() {
      const src = path.resolve(__dirname, "node_modules/@excalidraw/excalidraw/dist/prod/fonts")
      fs.cpSync(src, path.resolve(__dirname, "dist/excalidraw-assets/fonts"), { recursive: true })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), excalidrawAssets()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    // Dev: proxy the API (and its WebSockets) to the running Python server.
    proxy: {
      "/api": { target: "http://localhost:8091", ws: true, changeOrigin: true },
    },
  },
})
