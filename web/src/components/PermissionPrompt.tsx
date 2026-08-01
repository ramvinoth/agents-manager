import { ShieldAlert, Check, X } from "lucide-react"
import { useStore } from "@/store"
import { Button } from "@/components/ui/button"

/**
 * Ask-mode tool approval. When a driven claude run wants to use a gated tool
 * (e.g. an MCP tool), the backend surfaces it here — the user Allows or Denies
 * per call and the decision is relayed back to the paused run. Only appears when
 * the chat is started in the "Ask" permission mode.
 */
export function PermissionPrompt() {
  const pending = useStore((s) => s.pendingApprovals)
  const decide = useStore((s) => s.decidePermission)
  if (!pending.length) return null
  return (
    <div className="mb-2 space-y-2">
      {pending.map((p) => {
        const input = typeof p.input === "string" ? p.input : JSON.stringify(p.input, null, 2)
        return (
          <div
            key={p.id}
            className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2.5 text-sm"
          >
            <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-amber-600 dark:text-amber-400">
              <ShieldAlert className="size-3.5" /> Permission requested
            </div>
            <div className="mb-2">
              <span className="font-mono font-medium">{p.tool_name}</span>
              {input && input !== "{}" && (
                <pre className="mt-1 max-h-32 overflow-auto rounded bg-background/60 p-2 font-mono text-xs text-muted-foreground">
                  {input}
                </pre>
              )}
            </div>
            <div className="flex gap-2">
              <Button size="sm" className="h-7 gap-1" onClick={() => decide(p.id, "allow")}>
                <Check className="size-3.5" /> Allow
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1"
                onClick={() => decide(p.id, "deny")}
              >
                <X className="size-3.5" /> Deny
              </Button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
