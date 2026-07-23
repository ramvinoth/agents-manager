import { useEffect, useState } from "react"
import { FolderOpen, GitBranch, KeyRound, Loader2, Lock } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { api } from "@/lib/api"
import { describeHost } from "@/lib/host"
import type { GitRepo } from "@/lib/types"
import { useStore, useAgentLabel } from "@/store"

export function NewSessionDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const projects = useStore((s) => s.projects)
  const loadProjects = useStore((s) => s.loadProjects)
  const startNewSession = useStore((s) => s.startNewSession)
  const pickDir = useStore((s) => s.pickDir)
  const fsOpen = useStore((s) => s.fsOpen)
  const currentHost = useStore((s) => s.currentHost)
  const hosts = useStore((s) => s.hosts)
  const agentLabel = useAgentLabel()
  const hostLabel = describeHost(currentHost, hosts, "this machine")
  const [cwd, setCwd] = useState("")
  const [name, setName] = useState("")
  const [message, setMessage] = useState("")
  const [advanced, setAdvanced] = useState(false)
  const [systemPrompt, setSystemPrompt] = useState("")
  const [goal, setGoal] = useState("")
  // "dir" starts in an existing directory; "clone" clones a GitHub repo first
  // (repos come from the host's GH_TOKEN via /api/git/repos).
  const [src, setSrc] = useState<"dir" | "clone">("dir")
  const [repos, setRepos] = useState<GitRepo[]>([])
  const [gitConfigured, setGitConfigured] = useState<boolean | null>(null)
  const [repo, setRepo] = useState("")
  const [branch, setBranch] = useState("")
  const [parentDir, setParentDir] = useState("~")
  const [cloning, setCloning] = useState(false)
  const [cloneErr, setCloneErr] = useState("")
  const [cloneProg, setCloneProg] = useState<{ phase: string; percent: number } | null>(null)
  // Inline GH_TOKEN setup — saves into the host's env vars, then pulls the repo list.
  const [token, setToken] = useState("")
  const [savingToken, setSavingToken] = useState(false)
  const [tokenErr, setTokenErr] = useState("")

  async function loadRepos() {
    try {
      const d: any = await api.gitRepos()
      if (d?.error) {
        // A token exists but GitHub rejected it — reopen the token form with the reason.
        setGitConfigured(false)
        setTokenErr(d.error)
        return
      }
      setGitConfigured(!!d?.configured)
      setRepos(Array.isArray(d?.repos) ? d.repos : [])
    } catch {
      setGitConfigured(false)
    }
  }

  useEffect(() => {
    if (!open) return
    loadProjects()
    setCloneErr("")
    setTokenErr("")
    loadRepos()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, loadProjects, currentHost])

  async function saveToken() {
    const t = token.trim()
    if (!t || savingToken) return
    setSavingToken(true)
    setTokenErr("")
    try {
      const d: any = await api.envSet(currentHost, "GH_TOKEN", t)
      if (d?.error) throw new Error(d.error)
      setToken("")
      await loadRepos()
    } catch (e: any) {
      setTokenErr(e?.message || String(e))
    } finally {
      setSavingToken(false)
    }
  }

  const repoName = repo.includes("/") ? repo.split("/")[1] : repo
  const targetDir = repoName ? `${parentDir.replace(/\/+$/, "") || "~"}/${repoName}` : ""
  const startDisabled =
    !message.trim() ||
    cloning ||
    (src === "dir" ? !cwd.trim() : !repo.trim() || !parentDir.trim() || !gitConfigured)

  async function start() {
    if (startDisabled) return
    let dir = cwd.trim()
    if (src === "clone") {
      setCloning(true)
      setCloneErr("")
      setCloneProg(null)
      try {
        const res = await api.gitClone({ repo: repo.trim(), dir: parentDir.trim(), branch: branch.trim() })
        const d = await res.json()
        if (!res.ok || d.error) throw new Error(d.error || `HTTP ${res.status}`)
        // Background job — poll phase/percent until it lands or fails.
        for (;;) {
          await new Promise((r) => setTimeout(r, 700))
          const st: any = await api.gitCloneStatus(d.job).catch(() => null)
          if (!st) continue // transient poll error — keep watching
          if (st.error) throw new Error(st.error)
          setCloneProg({ phase: st.phase || "Cloning", percent: st.percent ?? 0 })
          if (!st.running) {
            if (!st.dir) throw new Error("Clone finished without a directory")
            dir = st.dir
            break
          }
        }
      } catch (e: any) {
        setCloneErr(e?.message || String(e))
        return
      } finally {
        setCloning(false)
        setCloneProg(null)
      }
    }
    onOpenChange(false)
    await startNewSession({
      cwd: dir,
      message: message.trim(),
      // Repo name is a sensible default title when cloning and none was given.
      title: name.trim() || (src === "clone" ? repoName : ""),
      systemPrompt: advanced ? systemPrompt : "",
      goal: advanced ? goal : "",
    })
    setMessage("")
    setName("")
    setRepo("")
    setBranch("")
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !cloning && onOpenChange(o)}>
      <DialogContent
        className="max-w-lg"
        // This is a form with a typed draft: never dismiss on an outside click/focus
        // (that also keeps it open while the folder picker is layered above it).
        onInteractOutside={(e) => e.preventDefault()}
        // Escape closes the picker first when it's open, otherwise closes this
        // dialog — but never mid-clone.
        onEscapeKeyDown={(e) => {
          if (fsOpen || cloning) e.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>New session</DialogTitle>
          <DialogDescription>
            Start a fresh {agentLabel} session on {hostLabel}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex gap-1 rounded-md bg-muted p-0.5 text-xs">
            {(
              [
                ["dir", "Existing directory"],
                ["clone", "Clone GitHub repo"],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setSrc(k)}
                className={
                  "flex-1 rounded px-2 py-1 transition-colors " +
                  (src === k ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground")
                }
              >
                {label}
              </button>
            ))}
          </div>
          {src === "dir" ? (
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Working directory</label>
              <div className="flex gap-2">
                <Input
                  value={cwd}
                  onChange={(e) => setCwd(e.target.value)}
                  list="ns-projdirs"
                  placeholder="/path/to/project"
                  className="flex-1"
                />
                <Button variant="outline" className="shrink-0 gap-1.5" onClick={() => pickDir((dir) => setCwd(dir))}>
                  <FolderOpen className="size-4" /> Browse
                </Button>
              </div>
              <datalist id="ns-projdirs">
                {projects.map((p, i) => (
                  <option key={i} value={String(p.cwd)} />
                ))}
              </datalist>
            </div>
          ) : (
            <div className="space-y-3">
              {gitConfigured === false ? (
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">GitHub token</label>
                  <div className="flex gap-2">
                    <Input
                      type="password"
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      placeholder="ghp_… or github_pat_…"
                      className="flex-1 font-mono text-xs"
                      spellCheck={false}
                      onKeyDown={(e) => e.key === "Enter" && saveToken()}
                    />
                    <Button
                      variant="outline"
                      className="shrink-0 gap-1.5"
                      onClick={saveToken}
                      disabled={!token.trim() || savingToken}
                    >
                      {savingToken ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
                      Save
                    </Button>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Saved as <span className="font-mono">GH_TOKEN</span> for {hostLabel} (manageable later in the Env
                    dialog) and used to list, clone, and push your repos.
                  </p>
                  {tokenErr && <p className="text-xs text-destructive">{tokenErr}</p>}
                </div>
              ) : (
                <>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">Repository</label>
                    <Input
                      value={repo}
                      onChange={(e) => setRepo(e.target.value)}
                      list="ns-gitrepos"
                      placeholder={gitConfigured === null ? "Loading repos…" : "owner/repo"}
                      className="font-mono text-xs"
                    />
                    <datalist id="ns-gitrepos">
                      {repos.map((r) => (
                        <option key={r.fullName} value={r.fullName}>
                          {r.private ? "private" : "public"}
                        </option>
                      ))}
                    </datalist>
                    {repos.find((r) => r.fullName === repo)?.private && (
                      <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                        <Lock className="size-3" /> private repo
                      </span>
                    )}
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">New branch</label>
                    <Input
                      value={branch}
                      onChange={(e) => setBranch(e.target.value)}
                      placeholder={`Optional — e.g. feature/my-change (blank stays on ${
                        repos.find((r) => r.fullName === repo)?.defaultBranch || "the default branch"
                      })`}
                      className="font-mono text-xs"
                      spellCheck={false}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">Clone into</label>
                    <div className="flex gap-2">
                      <Input
                        value={parentDir}
                        onChange={(e) => setParentDir(e.target.value)}
                        placeholder="~"
                        className="flex-1"
                      />
                      <Button
                        variant="outline"
                        className="shrink-0 gap-1.5"
                        onClick={() => pickDir((dir) => setParentDir(dir))}
                      >
                        <FolderOpen className="size-4" /> Browse
                      </Button>
                    </div>
                    {targetDir && !cloning && (
                      <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                        <GitBranch className="size-3 shrink-0" /> Will clone into{" "}
                        <span className="font-mono">{targetDir}</span>
                        {branch.trim() && (
                          <>
                            , branch <span className="font-mono">{branch.trim()}</span>
                          </>
                        )}
                        , and start the session there.
                      </p>
                    )}
                  </div>
                  {cloning && (
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                        <span>{cloneProg?.phase || "Starting clone…"}</span>
                        <span>{cloneProg ? `${cloneProg.percent}%` : ""}</span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
                          style={{ width: `${Math.max(3, cloneProg?.percent ?? 0)}%` }}
                        />
                      </div>
                    </div>
                  )}
                  {cloneErr && <p className="text-xs text-destructive">{cloneErr}</p>}
                </>
              )}
            </div>
          )}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Session name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={src === "clone" && repoName ? repoName : "Optional — defaults to an auto title"}
              maxLength={200}
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">First message</label>
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={`What should ${agentLabel} do?`}
              className="min-h-24"
            />
          </div>
          <button
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setAdvanced((a) => !a)}
          >
            {advanced ? "− Hide" : "+ Advanced"} (system prompt, goal)
          </button>
          {advanced && (
            <div className="space-y-3">
              <Textarea
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder="Optional system prompt (--append-system-prompt)"
                className="min-h-16 text-xs"
              />
              <Input value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Optional goal" />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={cloning}>
            Cancel
          </Button>
          <Button onClick={start} disabled={startDisabled}>
            {cloning && <Loader2 className="mr-1.5 size-4 animate-spin" />}
            {cloning ? "Cloning…" : "Start session"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
