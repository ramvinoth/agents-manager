import { createContext, useCallback, useContext, useState, type ReactNode } from "react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { FilePreview } from "@/components/FilePreview"
import { api } from "@/lib/api"
import { userError } from "@/lib/errors"
import { fileLinkPath, splitPath } from "@/lib/fileLink"
import type { FileListResponse } from "@/lib/types"
import type { TreeRow } from "@/lib/fileTree"

/** Opens a file link from rendered markdown (its raw href). Absent outside a
 *  provider, where file links stay inert. */
const FileLinkContext = createContext<((href: string) => void) | null>(null)
export const useFileLinkOpener = () => useContext(FileLinkContext)

type Shown = { row: TreeRow } | { path: string; error: string }

/** Makes file links inside `children` open in the file preview: the href is
 *  resolved against `cwd` (the session's working folder) and looked up in its
 *  folder's listing — the preview needs the entry's size to pick a viewer.
 *  Nothing is fetched until a link is clicked. */
export function FileLinkProvider({ cwd, children }: { cwd?: string | null; children: ReactNode }) {
  const [shown, setShown] = useState<Shown | null>(null)
  const open = useCallback(async (href: string) => {
    const path = fileLinkPath(href, cwd)
    if (!path) {
      setShown({ path: href, error: "This chat's working folder isn't known yet, so this relative link can't be placed." })
      return
    }
    const { dir, name } = splitPath(path)
    try {
      const d = (await api.fs(dir, true)) as FileListResponse & { error?: string }
      if (d.error) throw new Error(d.error)
      const entry = d.entries.find((e) => e.name === name)
      if (!entry) setShown({ path, error: "This file isn't there any more — it may have been moved or deleted." })
      else if (entry.dir) setShown({ path, error: "This link points at a folder. Open it from Files." })
      else setShown({ row: { path: d.path.replace(/\/+$/, "") + "/" + name, entry, depth: 0, expanded: false, loading: false } })
    } catch (e) {
      setShown({ path, error: userError(e, "this file") })
    }
  }, [cwd])
  return (
    <FileLinkContext.Provider value={open}>
      {children}
      {shown && "row" in shown && <FilePreview row={shown.row} onClose={() => setShown(null)} />}
      {shown && "error" in shown && (
        <Dialog open onOpenChange={(o) => !o && setShown(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader className="min-w-0">
              <DialogTitle>Can't open this file</DialogTitle>
              <DialogDescription className="truncate font-mono text-xs" title={shown.path}>{shown.path}</DialogDescription>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">{shown.error}</p>
          </DialogContent>
        </Dialog>
      )}
    </FileLinkContext.Provider>
  )
}
