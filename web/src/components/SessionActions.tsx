import { useState } from "react"
import { MoreVertical, Pencil, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useStore } from "@/store"

export function SessionActions() {
  const currentSessionPath = useStore((s) => s.currentSessionPath)
  const sessions = useStore((s) => s.sessions)
  const renameCurrent = useStore((s) => s.renameCurrent)
  const deleteByPath = useStore((s) => s.deleteByPath)
  const [renameOpen, setRenameOpen] = useState(false)
  const [delOpen, setDelOpen] = useState(false)
  const current = sessions.find((x) => x.path === currentSessionPath)
  const [title, setTitle] = useState("")

  if (!currentSessionPath) return null

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-7" aria-label="Session actions">
            <MoreVertical className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={() => {
              setTitle(current?.title || "")
              setRenameOpen(true)
            }}
          >
            <Pencil className="size-3.5" /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onClick={() => setDelOpen(true)}>
            <Trash2 className="size-3.5" /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename session</DialogTitle>
          </DialogHeader>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Session title"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                renameCurrent(title)
                setRenameOpen(false)
              }
            }}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                renameCurrent(title)
                setRenameOpen(false)
              }}
            >
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={delOpen} onOpenChange={setDelOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete session?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            "{current?.title || "this session"}" will be moved to the viewer trash.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDelOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                deleteByPath(currentSessionPath)
                setDelOpen(false)
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
