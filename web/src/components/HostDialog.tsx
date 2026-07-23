import { useState } from "react"
import { Loader2, Trash2, Plug } from "lucide-react"
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
import { useStore } from "@/store"
import type { HostInfo } from "@/lib/types"

/** Add / edit a remote SSH host (BYOH). `host` null = add, a HostInfo = edit. */
export function HostDialog({ host, onClose }: { host: HostInfo | null; onClose: () => void }) {
  const editing = !!host
  const refreshHosts = useStore((s) => s.refreshHosts)
  const setHost = useStore((s) => s.setHost)
  const currentHost = useStore((s) => s.currentHost)

  const [label, setLabel] = useState(host?.label ?? "")
  const [addr, setAddr] = useState(host?.host ?? "")
  const [port, setPort] = useState(String(host?.port ?? 22))
  const [user, setUser] = useState(host?.user ?? "")
  const [authMethod, setAuthMethod] = useState<"password" | "key">(host?.auth ?? "password")
  const [password, setPassword] = useState("")
  const [keyFile, setKeyFile] = useState(host?.keyFile ?? "")
  const [keyPassphrase, setKeyPassphrase] = useState("")
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState<"" | "test" | "save" | "delete">("")
  const [confirmDelete, setConfirmDelete] = useState(false)

  const cfg = () => ({
    id: host?.id,
    label: label.trim(),
    host: addr.trim(),
    port: port.trim() || 22,
    user: user.trim(),
    authMethod,
    password: authMethod === "password" ? password : "",
    keyFile: authMethod === "key" ? keyFile.trim() : "",
    keyPassphrase: authMethod === "key" ? keyPassphrase : "",
  })

  async function test() {
    setBusy("test")
    setNote({ ok: true, text: "Testing connection…" })
    try {
      const d = await api.hostsTest(cfg())
      setNote({ ok: !!d.ok, text: (d.ok ? "✓ " : "✗ ") + d.message })
    } catch (e: any) {
      setNote({ ok: false, text: e?.message || String(e) })
    } finally {
      setBusy("")
    }
  }

  async function save() {
    const c = cfg()
    if (!c.label || !c.host || !c.user) {
      setNote({ ok: false, text: "Label, host and user are required" })
      return
    }
    setBusy("save")
    try {
      const d = await api.hostsSave(c)
      if (d.error) throw new Error(d.error)
      await refreshHosts()
      onClose()
      if (d.saved) setHost(d.saved) // switch to the newly saved host
    } catch (e: any) {
      setNote({ ok: false, text: e?.message || String(e) })
      setBusy("")
    }
  }

  async function del() {
    if (!host) return
    setBusy("delete")
    try {
      await api.hostsDelete(host.id)
      await refreshHosts()
      onClose()
      if (currentHost === host.id) setHost("local")
    } catch (e: any) {
      setNote({ ok: false, text: e?.message || String(e) })
      setBusy("")
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit host" : "Add remote host"}</DialogTitle>
          <DialogDescription>
            Stored 0600 under ~/.claude. The remote needs the agent installed and signed in.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            Label
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Dev box" autoFocus />
          </label>
          <div className="flex gap-2">
            <label className="flex flex-1 flex-col gap-1 text-xs font-medium text-muted-foreground">
              Host / IP
              <Input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="10.0.0.5 or box.tailnet.ts.net" />
            </label>
            <label className="flex w-20 flex-col gap-1 text-xs font-medium text-muted-foreground">
              Port
              <Input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
            </label>
          </div>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            User
            <Input value={user} onChange={(e) => setUser(e.target.value)} placeholder="username" />
          </label>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Authentication</span>
            <div className="inline-flex w-fit rounded-md border border-border p-0.5 text-xs">
              {(["password", "key"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setAuthMethod(m)}
                  className={
                    "rounded px-2.5 py-1 transition-colors " +
                    (authMethod === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent")
                  }
                >
                  {m === "password" ? "Password" : "Key / certificate"}
                </button>
              ))}
            </div>
          </div>

          {authMethod === "password" ? (
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              Password {editing && <span className="font-normal">(leave blank to keep saved)</span>}
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="ssh password"
                autoComplete="new-password"
              />
            </label>
          ) : (
            <>
              <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                Private key file
                <Input
                  value={keyFile}
                  onChange={(e) => setKeyFile(e.target.value)}
                  placeholder="~/.ssh/id_ed25519"
                  spellCheck={false}
                />
                <span className="font-normal text-muted-foreground">
                  Path on the viewer host. An adjacent <span className="font-mono">-cert.pub</span> certificate is used
                  automatically. Leave blank to use the ssh-agent / default keys.
                </span>
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                Key passphrase {editing && <span className="font-normal">(leave blank to keep saved)</span>}
                <Input
                  type="password"
                  value={keyPassphrase}
                  onChange={(e) => setKeyPassphrase(e.target.value)}
                  placeholder="only if the key is encrypted"
                  autoComplete="new-password"
                />
              </label>
            </>
          )}
          {note && (
            <div className={note.ok ? "text-xs text-emerald-500" : "text-xs text-destructive"}>{note.text}</div>
          )}
        </div>

        <DialogFooter className="sm:justify-between">
          {editing ? (
            confirmDelete ? (
              <span className="flex items-center gap-1 text-xs">
                <span className="text-muted-foreground">Delete this host?</span>
                <Button size="sm" variant="destructive" onClick={del} disabled={!!busy}>
                  {busy === "delete" ? <Loader2 className="size-3.5 animate-spin" /> : "Yes"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                  No
                </Button>
              </span>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => setConfirmDelete(true)}
                disabled={!!busy}
              >
                <Trash2 className="size-3.5" /> Delete
              </Button>
            )
          ) : (
            <span />
          )}
          <span className="flex gap-2">
            <Button variant="outline" onClick={test} disabled={!!busy}>
              {busy === "test" ? <Loader2 className="size-3.5 animate-spin" /> : <Plug className="size-3.5" />} Test
            </Button>
            <Button onClick={save} disabled={!!busy}>
              {busy === "save" ? <Loader2 className="size-3.5 animate-spin" /> : "Save"}
            </Button>
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
