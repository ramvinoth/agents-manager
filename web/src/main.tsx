import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import App from "./App.tsx"
import { ErrorBoundary } from "./components/ErrorBoundary"

// After an update the server holds only the new release's chunks, so a tab
// opened before it 404s on its first lazy dialog. Reload once to pick up the
// new build; the guard stops a loop if the chunk is missing after the reload too.
window.addEventListener("vite:preloadError", (event) => {
  const key = "agents:chunk-reload"
  if (Date.now() - Number(sessionStorage.getItem(key) || 0) < 10_000) return
  sessionStorage.setItem(key, String(Date.now()))
  event.preventDefault()
  window.location.reload()
})

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary label="The app hit an unexpected error">
      <App />
    </ErrorBoundary>
  </StrictMode>
)
