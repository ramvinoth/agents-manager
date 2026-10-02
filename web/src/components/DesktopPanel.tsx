import { useEffect, useRef, useState } from "react"
import { Loader2, Monitor, ExternalLink } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useStore } from "@/store"

/**
 * The deployment's remote desktop, embedded.
 *
 * An <iframe>, not a client the app implements. The desktop is Neko, which
 * ships its own web client and does its own WebRTC negotiation, signalling and
 * input capture; reimplementing any of that here would be a second client to
 * keep in step with a stream protocol this app does not own. The iframe is the
 * whole integration — which is why this file is short, and should stay so.
 *
 * The src comes from /api/desktop fully formed, credential included (see
 * routes/panels.py). This component never sees the password as a separate
 * value and so has nothing to leak into a title, a log or a copied link.
 */
export function DesktopPanel({ onState }: { onState?: (s: string) => void }) {
  const url = useStore((s) => s.desktopUrl)
  const [loaded, setLoaded] = useState(false)
  // Remount key: a stream that dropped is recovered by reloading the frame,
  // which is all the "reconnect" an iframe affords us.
  const [attempt, setAttempt] = useState(0)
  const frameRef = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    onState?.(loaded ? "connected" : "connecting…")
  }, [loaded, onState])

  useEffect(() => {
    setLoaded(false)
  }, [attempt, url])

  if (!url) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-muted/20 p-6 text-center">
        <Monitor className="size-8 text-muted-foreground opacity-40" />
        <div className="text-sm text-muted-foreground">No desktop on this host</div>
        <div className="max-w-sm text-xs text-muted-foreground">
          A desktop appears here when the deployment provides one. Set
          <span className="mx-1 font-mono">VIEWER_DESKTOP_URL</span>
          to the stream's published address.
        </div>
      </div>
    )
  }

  return (
    <div className="relative h-full w-full bg-black">
      {!loaded && (
        <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-background text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Connecting to the desktop…
        </div>
      )}
      <div className="absolute right-2 top-2 z-20 flex gap-1 opacity-60 transition-opacity hover:opacity-100">
        <Button
          variant="secondary"
          size="icon"
          className="size-6"
          onClick={() => setAttempt((n) => n + 1)}
          title="Reload the desktop stream"
          aria-label="Reload desktop"
        >
          <Monitor className="size-3.5" />
        </Button>
        <Button variant="secondary" size="icon" className="size-6" asChild>
          {/* noreferrer matters here beyond the usual: the URL carries the
              desktop password in its query, and Referer would carry it to
              whatever the new tab navigates to next. */}
          <a href={url} target="_blank" rel="noreferrer" title="Open the desktop in a new tab">
            <ExternalLink className="size-3.5" />
          </a>
        </Button>
      </div>
      <iframe
        key={attempt}
        ref={frameRef}
        src={url}
        title="Remote desktop"
        onLoad={() => setLoaded(true)}
        className="h-full w-full border-0"
        // The desktop needs pointer lock for mouse capture and clipboard for
        // copy/paste to be usable at all; without these it renders but cannot
        // really be driven.
        allow="clipboard-read; clipboard-write; pointer-lock; fullscreen; autoplay"
      />
    </div>
  )
}
