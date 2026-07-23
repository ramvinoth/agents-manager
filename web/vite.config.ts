import path from "path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
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
