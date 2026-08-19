import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"

/**
 * A focused modal for editing one long-text session-meta field (System prompt,
 * Goal, …). Save writes the new value; Clear empties it (both go through the
 * caller's onSave, so the single /api/session-meta round-trip stays in the
 * store). One component, reused per field — no duplicated editor code.
 */
export function TextFieldDialog({
  title,
  description,
  value,
  placeholder,
  multiline = true,
  onSave,
  onClose,
}: {
  title: string
  description?: string
  value: string
  placeholder?: string
  multiline?: boolean
  onSave: (value: string) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState(value)

  function save() {
    onSave(draft.trim())
    onClose()
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        {multiline ? (
          <Textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={placeholder}
            className="min-h-40 resize-none text-sm leading-relaxed"
          />
        ) : (
          <Input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={placeholder}
            className="text-sm"
          />
        )}

        <DialogFooter className="sm:justify-between">
          <Button
            variant="ghost"
            className="text-destructive hover:text-destructive"
            disabled={!draft.trim()}
            onClick={() => {
              setDraft("")
              onSave("")
              onClose()
            }}
          >
            Clear
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={save}>Save</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
