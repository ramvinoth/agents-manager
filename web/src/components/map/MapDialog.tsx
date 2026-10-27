import { useCallback, useEffect, useState } from "react"
import { ChevronRight, FileCode2, Folder, Loader2, Box, Braces } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { MermaidDiagram } from "@/components/MermaidDiagram"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import { crumbs, drillTarget } from "@/lib/codeMap"
import type { MapLevel, MapNode, MapView, OrgProject } from "@/lib/types"
import { userError } from "@/lib/errors"

const POLL_MS = 5000

/**
 * MapDialog — the project's code as a drill-down graph (the Map lens). The
 * server parses the repo with tree-sitter (viewer/codemap.py) and returns one
 * level at a time: top folders → a folder's files → one file's classes and
 * functions. The diagram is Mermaid (no click handlers by design), so drilling
 * happens in the list beside it. Files an agent is writing light up amber, live:
 * the dialog re-reads every few seconds while open.
 */
export function MapDialog({ host, cwd, name, onClose }: {
  host: string
  cwd: string
  name: string
  onClose: () => void
}) {
  const [project, setProject] = useState<OrgProject | null>(null)
  const [at, setAt] = useState<{ level: MapLevel; path: string }>({ level: "project", path: "" })
  const [view, setView] = useState<MapView | null>(null)
  const [err, setErr] = useState("")
  const dark = document.documentElement.classList.contains("dark")

  useEffect(() => {
    api.orgProjectForCwd({ host, cwd, name }).then(setProject, (e) => setErr(userError(e, "this project")))
  }, [host, cwd, name])

  const load = useCallback(async () => {
    if (!project) return
    try {
      setView(await api.orgMap(project.id, at.level, at.path))
      setErr("")
    } catch (e) {
      setErr(userError(e, "the code map"))
    }
  }, [project, at])

  useEffect(() => {
    setView(null)
    load()
    const t = setInterval(load, POLL_MS)
    return () => clearInterval(t)
  }, [load])

  const open = (n: MapNode) => {
    const next = drillTarget(n)
    if (next) setAt(next)
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[90vh] max-w-[95vw] flex-col sm:max-w-[95vw]">
        <DialogHeader>
          <DialogTitle>Map · {project?.name || name}</DialogTitle>
          <DialogDescription>
            This project's code as a graph: folders, then files, then classes and functions. Arrows are imports.
            Amber means an agent wrote that file in the last 15 minutes.
          </DialogDescription>
        </DialogHeader>
        <nav className="flex flex-wrap items-center gap-1 text-sm" aria-label="Map location">
          {crumbs(at, project?.name || name).map((c, i, all) => (
            <span key={c.path + c.level} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="size-3.5 text-muted-foreground" />}
              <button
                onClick={() => setAt({ level: c.level, path: c.path })}
                disabled={i === all.length - 1}
                className="rounded px-1.5 py-0.5 font-medium hover:bg-accent disabled:text-foreground disabled:hover:bg-transparent"
              >
                {c.label}
              </button>
            </span>
          ))}
        </nav>
        {err ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
            <p>{err}</p>
            <Button variant="outline" size="sm" onClick={load}>Try again</Button>
          </div>
        ) : !view ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" /> Reading the code… (the first map of a big repo takes a few seconds)
          </div>
        ) : !view.available ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm">
            <p className="font-medium">The code map isn't installed on this machine.</p>
            <p className="text-muted-foreground">Install it once, then reopen the map:</p>
            <code className="rounded bg-muted px-2 py-1 text-xs">{view.install}</code>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 gap-3">
            <div className="min-w-0 flex-1 overflow-auto rounded-md border border-border p-2">
              {view.nodes.length ? (
                <MermaidDiagram source={view.mermaid} dark={dark} />
              ) : (
                <p className="p-4 text-sm text-muted-foreground">No source files here that the map can read.</p>
              )}
            </div>
            <aside className="flex w-72 shrink-0 flex-col overflow-hidden rounded-md border border-border">
              <div className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
                {view.files} files mapped{view.truncated ? " · showing the most connected" : ""}
              </div>
              <ul className="flex-1 overflow-y-auto p-1">
                {view.nodes.map((n) => (
                  <li key={n.id}>
                    <button
                      onClick={() => open(n)}
                      disabled={!drillTarget(n) || (n.id === view.path && view.level === "file")}
                      title={n.id}
                      className={cn(
                        "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-accent disabled:cursor-default disabled:hover:bg-transparent",
                        n.touched && "bg-amber-500/15",
                      )}
                    >
                      <NodeIcon kind={n.kind} />
                      <span className="min-w-0 flex-1 truncate">{n.label}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {n.kind === "folder" ? n.files : n.line ? `:${n.line}` : n.symbols || ""}
                      </span>
                      {n.touched && <span className="size-2 shrink-0 rounded-full bg-amber-500" aria-label="an agent edited this" />}
                    </button>
                  </li>
                ))}
              </ul>
            </aside>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function NodeIcon({ kind }: { kind: MapNode["kind"] }) {
  const cls = "size-4 shrink-0 text-muted-foreground"
  if (kind === "folder") return <Folder className={cls} />
  if (kind === "file") return <FileCode2 className={cls} />
  if (kind === "class") return <Box className={cls} />
  return <Braces className={cls} />
}
