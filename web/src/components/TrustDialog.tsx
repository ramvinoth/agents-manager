import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { api } from "@/lib/api"
import { ORG_LEVELS, LEVEL_NAME, POLICIES, isOrgLevel, trustOutcome, type OrgLevel, type PermissionPolicy } from "@/lib/trust"

/** A chat's Trust: its saved Claude Code permission policy and its Manager
 *  level. The web twin of the mobile Trust card (SessionProfileScreen) — same
 *  endpoints, same plain level names. */
export function TrustDialog({ path, open, onOpenChange }: { path: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [target, setTarget] = useState("")
  const [mode, setMode] = useState("")
  const [level, setLevel] = useState<OrgLevel | "">("")
  const [effective, setEffective] = useState<OrgLevel | "">("")
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState("")
  const [reload, setReload] = useState(0)

  useEffect(() => {
    if (!open) return
    let live = true
    setNote(""); setBusy(true)
    // session-meta, not session-detail: Trust needs three stored fields, and
    // the detail also summarises the whole transcript (seconds on a big chat).
    api.sessionMeta(path).then((d) => {
      if (!live) return
      if (!d.session || typeof d.permission_mode !== "string") throw new Error("old server")
      setTarget(d.session)
      setMode(d.permission_mode)
      setLevel(isOrgLevel(d.level) ? d.level : "")
      setEffective(isOrgLevel(d.effective_level) ? d.effective_level : "")
    }).catch(() => { if (live) setNote("Could not load this chat's Trust. Close and try again.") })
      .finally(() => { if (live) setBusy(false) })
    return () => { live = false }
  }, [open, path, reload])

  const write = async (run: () => Promise<Parameters<typeof trustOutcome>[0]>, field: "permission_mode" | "level", want: string) => {
    setBusy(true); setNote("")
    try {
      const out = trustOutcome(await run(), target, field, want)
      setNote(out.note)
      if (out.applied) setReload((n) => n + 1)
    } catch {
      setNote("Could not save. Please retry.")
    } finally {
      setBusy(false)
    }
  }
  const pick = <T extends string>(opts: { v: T; label: string }[], cur: string, on: (v: T) => void, label: string) => (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
      {opts.map((o) => (
        <Button key={o.v || "default"} size="sm" variant={o.v === cur ? "default" : "outline"} role="radio"
          aria-checked={o.v === cur} disabled={busy || !target} onClick={() => { if (o.v !== cur) on(o.v) }}>
          {o.label}
        </Button>
      ))}
    </div>
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Trust</DialogTitle></DialogHeader>
        <div className="space-y-4 text-sm">
          <section className="space-y-1.5">
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground">PERMISSION POLICY · CLAUDE CODE TOOLS</h3>
            <p className="text-muted-foreground">Gates the agent's own shell and file tools, for every future run of this chat (chat and scheduled). Ask follows tool rules; Accept edits allows file edits; Plan restricts changes; Bypass skips ordinary prompts.</p>
            {pick(POLICIES, mode, (v: PermissionPolicy) => write(() => api.sessionModeSet(target, v), "permission_mode", v), "Permission policy")}
            {!mode && target ? <p className="text-muted-foreground">No saved policy: each run uses the mode it was started with.</p> : null}
          </section>
          <section className="space-y-1.5">
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground">BOARD AUTHORITY · HOW FAR IT ACTS ALONE</h3>
            <p className="text-muted-foreground">How far this chat may reach with no approval from you, enforced by the server for any harness. <b>Own work</b> — its own cards, notes and messages. <b>Workspace</b> — also projects, columns and scheduled loops. <b>Organization</b> — also org-wide settings. Asks above its level wait for your approval instead of failing, and anything destructive or paid always asks you, whatever the level.</p>
            {pick([{ v: "" as OrgLevel | "", label: "Agent default" }, ...ORG_LEVELS.map((v) => ({ v: v as OrgLevel | "", label: LEVEL_NAME[v] }))],
              level, (v) => write(() => api.sessionLevelSet(target, v), "level", v), "Board authority")}
            {effective ? <p className="text-muted-foreground">Acting at {LEVEL_NAME[effective]}{level ? " (set for this chat)" : " (from the agent it was started from)"}. Applies from the next run.</p> : null}
          </section>
          {busy ? <p className="text-muted-foreground">{target ? "Saving…" : "Loading…"}</p> : null}
          {note ? <p role="alert" className="text-destructive">{note}</p> : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
