import { useState } from "react"
import { MoreVertical, Pencil, ShieldCheck, Trash2 } from "lucide-react"
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
import type { SessionListItem } from "@/lib/types"
import { TrustDialog } from "@/components/TrustDialog"

/** One chat's ⋮ menu in the session rail: Rename, Trust… (Claude chats) and Delete. */
export function SessionActions({ session }: { session: SessionListItem }) {
  const renameByPath = useStore((s) => s.renameByPath)
  const deleteByPath = useStore((s) => s.deleteByPath)
  const [renameOpen, setRenameOpen] = useState(false)
  const [delOpen, setDelOpen] = useState(false)
  const [trustOpen, setTrustOpen] = useState(false)
  // Trust is the server policy of a Claude Code chat (mobile shows it for claude only too).
  const isClaude = !session.harness || session.harness === "claude"
  const [title, setTitle] = useState("")
  const rename = () => {
    renameByPath(session.path, title)
    setRenameOpen(false)
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 text-muted-foreground"
            data-track="session menu"
            aria-label={`Actions for ${session.title || "this chat"}`}
          >
            <MoreVertical className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={() => {
              setTitle(session.title || "")
              setRenameOpen(true)
            }}
          >
            <Pencil className="size-3.5" /> Rename
          </DropdownMenuItem>
          {isClaude ? (
            <DropdownMenuItem onClick={() => setTrustOpen(true)}>
              <ShieldCheck className="size-3.5" /> Trust…
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem variant="destructive" onClick={() => setDelOpen(true)}>
            <Trash2 className="size-3.5" /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {isClaude ? <TrustDialog path={session.path} open={trustOpen} onOpenChange={setTrustOpen} /> : null}

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename session</DialogTitle>
          </DialogHeader>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Session title"
            onKeyDown={(e) => {
              if (e.key === "Enter") rename()
            }}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>
              Cancel
            </Button>
            <Button onClick={rename}>Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={delOpen} onOpenChange={setDelOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete session?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            "{session.title || "this session"}" will be moved to the viewer trash.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDelOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                deleteByPath(session.path)
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
