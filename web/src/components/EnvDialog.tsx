import { useEffect, useState } from "react"
import { Eye, EyeOff, Trash2, Plus, Loader2 } from "lucide-react"
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
import { api } from "@/lib/api"
import { describeHost } from "@/lib/host"
import { useStore } from "@/store"

/** Per-host environment variables (e.g. GH_TOKEN). Values are masked and only
 *  fetched when the user reveals a row. */
export function EnvDialog({ onClose }: { onClose: () => void }) {
  const currentHost = useStore((s) => s.currentHost)
  const hosts = useStore((s) => s.hosts)
  const label = describeHost(currentHost, hosts)

  const [keys, setKeys] = useState<string[]>([])
  const [shown, setShown] = useState<Record<string, string>>({}) // key -> revealed/edited value
  const [newKey, setNewKey] = useState("")
  const [newVal, setNewVal] = useState("")
  const [err, setErr] = useState("")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.env(currentHost).then((d: any) => setKeys(d.keys || [])).catch(() => {})
  }, [currentHost])

  async function reveal(k: string) {
    if (k in shown) {
      setShown((s) => { const n = { ...s }; delete n[k]; return n })
      return
    }
    try {
      const d: any = await api.envValue(currentHost, k)
      if (d.value !== undefined) setShown((s) => ({ ...s, [k]: d.value }))
    } catch { /* ignore */ }
  }

  async function upsert(k: string, v: string) {
    setErr("")
    const key = k.trim()
    if (!key || !v) { setErr("Key and value are both required"); return }
    setBusy(true)
    try {
      const d: any = await api.envSet(currentHost, key, v)
      if (d.error) { setErr(d.error); return }
      setKeys(d.keys || [])
      setNewKey(""); setNewVal("")
      setShown((s) => { const n = { ...s }; delete n[key]; return n }) // re-mask after save
    } finally {
      setBusy(false)
    }
  }

  async function remove(k: string) {
    const d: any = await api.envUnset(currentHost, k)
    setKeys(d.keys || [])
    setShown((s) => { const n = { ...s }; delete n[k]; return n })
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Environment · {label}</DialogTitle>
          <DialogDescription>
            Variables injected into this host's terminal and agent runs (e.g.{" "}
            <span className="font-mono">GH_TOKEN</span> for Copilot). Stored 0600 under ~/.claude; values stay
            hidden until you reveal them.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          {keys.length === 0 && <p className="text-xs text-muted-foreground">No variables set for this host yet.</p>}
          {keys.map((k) => {
            const revealed = k in shown
            return (
              <div key={k} className="flex items-center gap-2">
                <span className="w-40 shrink-0 truncate font-mono text-xs" title={k}>{k}</span>
                {revealed ? (
                  <Input
                    className="h-8 flex-1 font-mono text-xs"
                    value={shown[k]}
                    onChange={(e) => setShown((s) => ({ ...s, [k]: e.target.value }))}
                    spellCheck={false}
                  />
                ) : (
                  <span className="flex-1 select-none font-mono text-xs text-muted-foreground">••••••••••••</span>
                )}
                <Button variant="ghost" size="icon" className="size-7" onClick={() => reveal(k)}
                  title={revealed ? "Hide" : "Reveal"}>
                  {revealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                </Button>
                {revealed && (
                  <Button variant="outline" size="sm" className="h-7" onClick={() => upsert(k, shown[k])} disabled={busy}>
                    Save
                  </Button>
                )}
                <Button variant="ghost" size="icon" className="size-7 text-destructive hover:text-destructive"
                  onClick={() => remove(k)} title="Delete">
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            )
          })}

          <div className="mt-1 flex items-center gap-2 border-t border-border pt-3">
            <Input
              className="h-8 w-40 shrink-0 font-mono text-xs"
              placeholder="GH_TOKEN"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              spellCheck={false}
            />
            <Input
              className="h-8 flex-1 font-mono text-xs"
              placeholder="value"
              value={newVal}
              onChange={(e) => setNewVal(e.target.value)}
              spellCheck={false}
              onKeyDown={(e) => e.key === "Enter" && upsert(newKey, newVal)}
            />
            <Button size="sm" className="h-8" onClick={() => upsert(newKey, newVal)} disabled={busy}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />} Add
            </Button>
          </div>
          {err && <div className="text-xs text-destructive">{err}</div>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
