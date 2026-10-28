import { useCallback, useState } from "react"
import { api } from "@/lib/api"
import { ProjectCanvas, StatusDot, type Status } from "./ProjectCanvas"

/** The project canvas alone, full screen: what the phone's WebView loads
 *  (/?canvasSession=<sid>&embed=1). The phone draws its own header; this adds
 *  only the live status, since a dropped socket must never look like silence. */
export default function CanvasEmbed({ session }: { session: string }) {
  const [live, setLive] = useState<{ status: Status; editable: boolean } | null>(null)
  const load = useCallback(() => api.canvasBoard({ session }), [session])
  return (
    <div className="relative flex h-dvh flex-col bg-background p-1 text-foreground">
      <ProjectCanvas load={load} onStatus={(status, editable) => setLive({ status, editable })} />
      {live && live.status !== "live" && (
        <div className="pointer-events-none absolute right-3 top-3 rounded-md bg-background/90 px-2 py-1 shadow">
          <StatusDot status={live.status} editable={live.editable} />
        </div>
      )}
    </div>
  )
}
