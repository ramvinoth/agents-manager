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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { useStore } from "@/store"
import { ProvidersDialog } from "../ProvidersDialog"

// Radix Select forbids an empty-string item value, so Default (Claude) — whose
// real provider id is "" — uses this sentinel in the dropdown only.
const DEFAULT_PROVIDER = "__default__"

/**
 * Per-session model provider chooser: pick Default (Claude) or a saved custom
 * endpoint, and (for a custom endpoint) the conversation mode. Selecting only
 * SETS the session's provider (via saveMeta) — the global library is managed in
 * the nested ProvidersDialog reached by "Manage providers".
 */
export function ModelProviderDialog({ onClose }: { onClose: () => void }) {
  const meta = useStore((s) => s.meta)
  const saveMeta = useStore((s) => s.saveMeta)
  const providers = useStore((s) => s.providers)
  const [manageOpen, setManageOpen] = useState(false)

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Model provider</DialogTitle>
          <DialogDescription>Route this chat to a custom model endpoint, or use your Claude login.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <Select
            value={meta?.provider ? meta.provider : DEFAULT_PROVIDER}
            onValueChange={(v) => saveMeta("provider", v === DEFAULT_PROVIDER ? "" : v)}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_PROVIDER}>Default (Claude)</SelectItem>
              {providers.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {meta?.provider && (
            <div>
              <div className="mb-1 text-[11px] text-muted-foreground">Conversation mode</div>
              <div className="grid grid-cols-2 gap-1.5">
                {(["chat", "agent"] as const).map((m) => {
                  const on = (meta?.convMode || "chat") === m
                  return (
                    <button
                      key={m}
                      onClick={() => saveMeta("convMode", m)}
                      className={cn(
                        "rounded-md border py-1.5 text-xs capitalize transition-colors",
                        on
                          ? "border-primary/40 bg-primary/10 text-foreground"
                          : "border-border text-muted-foreground hover:bg-accent hover:text-foreground"
                      )}
                    >
                      {m}
                    </button>
                  )
                })}
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground/60">
                Chat proxies plainly to the endpoint; Agent runs the full harness against it.
              </p>
            </div>
          )}

          <Button variant="outline" size="sm" className="self-start" onClick={() => setManageOpen(true)}>
            Manage providers
          </Button>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>

      {manageOpen && <ProvidersDialog onClose={() => setManageOpen(false)} />}
    </Dialog>
  )
}
