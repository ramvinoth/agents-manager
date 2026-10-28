import { useCallback, useRef, useState } from "react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { api } from "@/lib/api"
import { ProjectCanvas, StatusDot, type Status } from "./ProjectCanvas"

/** The project canvas in a dialog (web): resolves the chat's folder to its project. */
export function CanvasDialog({ host, cwd, name, onClose }: {
  host: string
  cwd: string
  name: string
  onClose: () => void
}) {
  const [title, setTitle] = useState(name)
  const [live, setLive] = useState<{ status: Status; editable: boolean } | null>(null)
  const settled = useRef<(() => boolean) | null>(null)

  const load = useCallback(async () => {
    const p = await api.orgProjectForCwd({ host, cwd, name })
    setTitle(p.name || name)
    return api.canvasBoard({ project: p.id })
  }, [host, cwd, name])

  // Closing with edits the server has not confirmed would lose them.
  const close = () => {
    if (settled.current && !settled.current() &&
      !window.confirm("Some edits have not reached the server yet. Close anyway and lose them?")) return
    onClose()
  }

  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent
        className="flex h-[90vh] max-w-[95vw] flex-col sm:max-w-[95vw]"
        onEscapeKeyDown={(e) => e.preventDefault()}   // Escape belongs to the drawing tools
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Canvas · {title}
            {live && <StatusDot status={live.status} editable={live.editable} />}
          </DialogTitle>
          <DialogDescription>
            One shared drawing board for this project. Everyone who has it open sees each change as it happens.
          </DialogDescription>
        </DialogHeader>
        <ProjectCanvas load={load} settledRef={settled} onStatus={(status, editable) => setLive({ status, editable })} />
      </DialogContent>
    </Dialog>
  )
}
