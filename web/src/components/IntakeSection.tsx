import { useEffect, useMemo, useState } from "react"
import { Check, Copy, Inbox, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { api } from "@/lib/api"
import { isQueued, type IntakeChannel, type OrgProject } from "@/lib/types"
import { useStore } from "@/store"
import { userError } from "@/lib/errors"

const SELECT = "h-7 rounded-md border border-border bg-background px-1 text-xs"

/**
 * IntakeSection — Integrations → "Intake channels": doors from the outside
 * world onto a board (viewer/intake.py). Each channel is a URL + token bound
 * to one project board and optionally one session; a POST becomes a card
 * there and wakes that session. One channel may also receive the owner's
 * in-app feedback ("Send feedback" on web and phone).
 *
 * The token is shown ONCE (on create / New token): only its hash is stored.
 */
export function IntakeSection() {
  const sessions = useStore((s) => s.sessions)
  const [channels, setChannels] = useState<IntakeChannel[] | null>(null)
  const [projects, setProjects] = useState<OrgProject[]>([])
  const [draft, setDraft] = useState<{ name: string; project: string; session: string; feedback: boolean } | null>(null)
  const [shown, setShown] = useState<{ id: string; token: string } | null>(null)
  const [copied, setCopied] = useState("")
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")

  const sessionOpts = useMemo(() => sessions
    .map((s) => ({ id: (s as { id?: string }).id || "", title: s.title }))
    .filter((s) => s.id), [sessions])
  const title = (sid: string) => sessionOpts.find((s) => s.id === sid)?.title || (sid ? sid.slice(0, 8) : "")
  const projectName = (pid: number) => {
    const p = projects.find((x) => x.id === pid)
    return p ? `${p.name} (${p.cwd})` : `project ${pid}`
  }

  async function load() {
    const [c, p] = await Promise.all([api.intakeList(), api.orgProjects()])
    setChannels(c.channels || [])
    setProjects(p.projects || [])
  }
  useEffect(() => { load().catch((e) => setError(userError(e, "intake channels"))) }, [])

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key); setError("")
    try {
      const r = await fn()
      if (r && typeof r === "object" && "error" in r) setError(String((r as { error: string }).error))
      else if (isQueued(r)) setError("Queued for the owner's approval.")
      else if (r && typeof r === "object" && "token" in r && (r as IntakeChannel).token) {
        const c = r as IntakeChannel
        setShown({ id: c.id, token: c.token! })
      }
      await load()
    } catch (e) {
      setError(userError(e, "the intake channel", "update"))
    } finally {
      setBusy("")
    }
  }

  const url = (c: IntakeChannel) => window.location.origin + c.path
  const copy = (key: string, text: string) => {
    navigator.clipboard?.writeText(text).then(() => { setCopied(key); setTimeout(() => setCopied(""), 1500) })
  }
  const curl = (c: IntakeChannel, token: string) =>
    `curl -X POST ${url(c)} -H 'X-Intake-Token: ${token}' -H 'Content-Type: application/json' -d '{"title":"Hello","text":"Details…"}'`

  return (
    <section className="rounded-md border" data-testid="integration-intake">
      <p className="flex gap-2 px-3 py-2.5 text-xs text-muted-foreground">
        <Inbox className="mt-0.5 size-3.5 shrink-0" />
        <span className="flex-1">
          A link anything outside can post to — a website form, a failing build, an alert, your own app feedback.
          Each post becomes a card on the board you pick and wakes the chat you pick to work on it.
        </span>
        {busy && <Loader2 className="size-3.5 animate-spin" />}
      </p>
      <div className="flex flex-col divide-y border-t">
        {channels === null && <div className="px-3 py-2 text-xs text-muted-foreground">Loading…</div>}
        {channels?.map((c) => (
          <div key={c.id} className="flex flex-col gap-1.5 px-3 py-2 text-sm" data-testid={`intake-${c.id}`}>
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-medium">{c.name}</span>
              <span className="text-xs text-muted-foreground">
                {c.received} received{c.last_used ? ` · last ${new Date(c.last_used * 1000).toLocaleString()}` : ""}
              </span>
              <button className="text-muted-foreground hover:text-foreground disabled:opacity-50" disabled={!!busy}
                title="New token (the old one stops working)" onClick={() => run(`rot:${c.id}`, () => api.intakeRotate(c.id))}>
                <RefreshCw className="size-3.5" />
              </button>
              <button className="text-muted-foreground hover:text-destructive disabled:opacity-50" disabled={!!busy}
                title="Close this channel"
                onClick={() => { if (confirm(`Close "${c.name}"? Posts to it will be refused.`)) run(`del:${c.id}`, () => api.intakeDelete(c.id)) }}>
                <Trash2 className="size-3.5" />
              </button>
            </div>
            <div className="text-xs text-muted-foreground">
              Board: {projectName(c.project_id)} · Wakes: {c.session_id ? title(c.session_id) : "nobody (board only)"}
            </div>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate font-mono text-xs">{url(c)}</code>
              <button className="text-muted-foreground hover:text-foreground" title="Copy URL" onClick={() => copy(`u:${c.id}`, url(c))}>
                {copied === `u:${c.id}` ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              </button>
            </div>
            {shown?.id === c.id && (
              <div className="rounded border border-amber-500/50 bg-amber-500/10 p-2 text-xs" data-testid="intake-token">
                <div className="mb-1 font-medium">Token — copy it now, it is not shown again:</div>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 break-all font-mono">{shown.token}</code>
                  <button title="Copy token" onClick={() => copy("tok", shown.token)}>
                    {copied === "tok" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                  </button>
                </div>
                <button className="mt-1 text-muted-foreground underline" onClick={() => copy("curl", curl(c, shown.token))}>
                  {copied === "curl" ? "Copied" : "Copy a test command (curl)"}
                </button>
              </div>
            )}
            <label className="flex items-center gap-2 text-xs">
              <Switch on={c.app_feedback} disabled={!!busy} testId={`intake-feedback-${c.id}`}
                onClick={() => run(`fb:${c.id}`, () => api.intakeUpdate({ id: c.id, app_feedback: !c.app_feedback }))} />
              Also receives my in-app feedback
            </label>
          </div>
        ))}
        {draft ? (
          <form className="flex flex-col gap-2 px-3 py-2" data-testid="intake-new"
            onSubmit={(e) => {
              e.preventDefault()
              run("new", () => api.intakeCreate({
                name: draft.name.trim(), project_id: Number(draft.project),
                for_session: draft.session || undefined, app_feedback: draft.feedback,
              })).then(() => setDraft(null))
            }}>
            <Input className="h-7 text-xs" placeholder="What feeds it, e.g. Website contact form" value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })} autoFocus />
            <select className={SELECT} value={draft.project} onChange={(e) => setDraft({ ...draft, project: e.target.value })}>
              <option value="">Board (project)…</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name} — {p.cwd}</option>)}
            </select>
            <select className={SELECT} value={draft.session} onChange={(e) => setDraft({ ...draft, session: e.target.value })}>
              <option value="">Wake nobody (cards wait on the board)</option>
              {sessionOpts.map((s) => <option key={s.id} value={s.id}>Wake: {s.title}</option>)}
            </select>
            <label className="flex items-center gap-2 text-xs">
              <Switch on={draft.feedback} onClick={() => setDraft({ ...draft, feedback: !draft.feedback })} />
              Also send my in-app feedback here
            </label>
            <div className="flex gap-2">
              <Button type="submit" size="sm" className="h-7 text-xs" disabled={!!busy || !draft.name.trim() || !draft.project}>
                Create
              </Button>
              <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setDraft(null)}>Cancel</Button>
            </div>
          </form>
        ) : (
          <div className="px-3 py-2">
            <Button variant="outline" size="sm" className="h-7 text-xs" disabled={!!busy}
              onClick={() => setDraft({ name: "", project: "", session: "", feedback: false })}>
              <Plus className="mr-1 size-3" /> New channel
            </Button>
          </div>
        )}
      </div>
      {error && <p className="px-3 pb-2 text-xs text-destructive">{error}</p>}
    </section>
  )
}
