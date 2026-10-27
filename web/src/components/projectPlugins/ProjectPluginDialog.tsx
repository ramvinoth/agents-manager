import { useCallback, useEffect, useState } from "react"
import { ExternalLink, Loader2 } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { api } from "@/lib/api"
import type { ProjectPlugin } from "@/lib/types"
import { userError } from "@/lib/errors"

/**
 * ProjectPluginDialog — an app that shares this project's folder (e.g. Sift),
 * full size, signed in and opened at the folder's own project. The server
 * mints a one-time sign-in per open, so "New tab" asks for a fresh one rather
 * than reusing the frame's spent URL.
 */
export function ProjectPluginDialog({ plugin, host, cwd, name, onClose }: {
  plugin: ProjectPlugin
  host: string
  cwd: string
  name: string
  onClose: () => void
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState("")
  const open = useCallback(() => api.projectPluginOpen({ id: plugin.id, host, cwd }), [plugin.id, host, cwd])

  useEffect(() => {
    let live = true
    open().then(
      (r) => live && setUrl(r.url),
      (e) => live && setError(userError(e, plugin.label, "open")),
    )
    return () => {
      live = false
    }
  }, [open, plugin.label])

  const newTab = async () => {
    // Open the tab inside the click so the browser allows it, then point it at the fresh sign-in.
    const tab = window.open("", "_blank")
    try {
      const r = await open()
      if (tab) tab.location.href = r.url
    } catch (e) {
      tab?.close()
      setError(userError(e, plugin.label, "open"))
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[94vh] max-w-[97vw] flex-col gap-2 p-3 sm:max-w-[97vw]">
        <DialogHeader className="flex-row items-center gap-3 space-y-0 pr-8">
          <div className="min-w-0 flex-1">
            <DialogTitle>{plugin.label} · {name}</DialogTitle>
            <DialogDescription className="truncate">{plugin.description}</DialogDescription>
          </div>
          <Button variant="outline" size="sm" onClick={newTab} disabled={!url}>
            <ExternalLink className="size-4" /> New tab
          </Button>
        </DialogHeader>
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-md border">
          {error ? (
            <p className="p-4 text-sm text-destructive">{error}</p>
          ) : url ? (
            <iframe title={`${plugin.label} · ${name}`} src={url} className="size-full border-0" allow="clipboard-read; clipboard-write; fullscreen" />
          ) : (
            <Loader2 className="absolute inset-0 m-auto size-6 animate-spin text-muted-foreground" />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
