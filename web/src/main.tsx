import { StrictMode, Suspense, lazy } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import App from "./App.tsx"
import { ErrorBoundary } from "./components/ErrorBoundary"

// After an update the server holds only the new release's chunks, so a tab
// opened before it 404s on its first lazy dialog. Reload once to pick up the
// new build; the guard stops a loop if the chunk is missing after the reload too.
window.addEventListener("vite:preloadError", (event) => {
  const key = "harman:chunk-reload"
  if (Date.now() - Number(sessionStorage.getItem(key) || 0) < 10_000) return
  sessionStorage.setItem(key, String(Date.now()))
  event.preventDefault()
  window.location.reload()
})

// The phone's WebView loads the project canvas alone (/?canvasSession=<sid>&embed=1&theme=dark|light):
// no chrome, the phone's theme, and Excalidraw fetched only for this view.
const CanvasEmbed = lazy(() => import("./components/canvas/CanvasEmbed"))
const q = new URLSearchParams(window.location.search)
const embedSession = q.get("embed") === "1" ? q.get("canvasSession") : null
if (embedSession) {
  const theme = q.get("theme")
  document.documentElement.classList.toggle("dark",
    theme ? theme === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches)
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary label="The app hit an unexpected error">
      {embedSession
        ? <Suspense fallback={null}><CanvasEmbed session={embedSession} /></Suspense>
        : <App />}
    </ErrorBoundary>
  </StrictMode>
)
