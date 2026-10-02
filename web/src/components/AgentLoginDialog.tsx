import { useState } from "react"
import { ExternalLink, Loader2, Copy, Check, LogIn, RefreshCw } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useStore } from "@/store"

export function AgentLoginDialog() {
  const agentLogin = useStore((s) => s.agentLogin)
  const submit = useStore((s) => s.submitAgentLogin)
  const cancel = useStore((s) => s.cancelAgentLogin)
  const restart = useStore((s) => s.startAgentLogin)
  const agents = useStore((s) => s.agents)
  const [callback, setCallback] = useState("")
  const [copied, setCopied] = useState(false)

  if (!agentLogin) return null
  const label = agents.find((a) => a.id === agentLogin.agent)?.label || agentLogin.agent
  const { stage, url, error, code } = agentLogin
  const isDevice = !!code // GitHub device flow (Copilot): show a code, no paste-back
  const ready = !!url

  return (
    <Dialog open onOpenChange={(o) => !o && cancel()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LogIn className="size-4" /> Sign in to {label}
          </DialogTitle>
        </DialogHeader>

        {isDevice ? (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground">1 · Open this page and sign in</div>
              <div className="flex gap-1.5">
                <div
                  className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted px-2 py-1.5 font-mono text-xs"
                  title={url || "https://github.com/login/device"}
                >
                  {url || "https://github.com/login/device"}
                </div>
                <Button size="sm" asChild>
                  <a href={url || "https://github.com/login/device"} target="_blank" rel="noreferrer">
                    <ExternalLink className="size-3.5" /> Open
                  </a>
                </Button>
              </div>
            </div>
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground">2 · Enter this code</div>
              <div className="flex items-center gap-2">
                <div className="rounded-md border border-border bg-muted px-3 py-2 font-mono text-lg font-semibold tracking-[0.2em]">
                  {code}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    navigator.clipboard?.writeText(code!)
                    setCopied(true)
                    setTimeout(() => setCopied(false), 1500)
                  }}
                  title="Copy code"
                >
                  {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                </Button>
              </div>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Waiting for you to approve… this closes automatically.
            </div>
            <div className="text-xs text-muted-foreground">
              Codes expire after about 15 minutes. If GitHub says the code has expired, get a new
              one below.
            </div>
            {error && <div className="text-xs text-destructive">{error}</div>}
          </div>
        ) : !ready ? (
          <div className="space-y-2 py-6">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              {stage !== "error" && <Loader2 className="size-4 animate-spin" />}
              {stage === "error" ? "Sign-in couldn't start." : "Preparing sign-in…"}
            </div>
            {error && <div className="text-xs text-destructive">{error}</div>}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground">
                1 · Open this URL in a new tab and sign in
              </div>
              <div className="flex gap-1.5">
                <div
                  className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted px-2 py-1.5 font-mono text-xs"
                  title={url!}
                >
                  {url}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    navigator.clipboard?.writeText(url!)
                    setCopied(true)
                    setTimeout(() => setCopied(false), 1500)
                  }}
                  title="Copy URL"
                >
                  {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                </Button>
                <Button size="sm" asChild>
                  <a href={url!} target="_blank" rel="noreferrer">
                    <ExternalLink className="size-3.5" /> Open
                  </a>
                </Button>
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground">
                2 · After signing in, your browser lands on a{" "}
                <span className="font-mono">localhost:1455/…</span> page (it may show a connection
                error — that's expected on a remote host). Copy that full URL and paste it here:
              </div>
              <Input
                value={callback}
                onChange={(e) => setCallback(e.target.value)}
                placeholder="http://localhost:1455/auth/callback?code=…&state=…"
                className="font-mono text-xs"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && callback.trim()) submit(callback.trim())
                }}
              />
            </div>

            {error && <div className="text-xs text-destructive">{error}</div>}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={cancel}>
            Cancel
          </Button>
          {/* A device code expires (GitHub's own ~15min, mirrored by the server's
              900s poll timeout), and the dialog otherwise has no way forward once
              it does. Restarting is safe to repeat: the manager cancels and resets
              the previous attempt before spawning a new `copilot login`. */}
          {(isDevice || stage === "error") && (
            <Button
              variant="outline"
              onClick={() => restart(agentLogin.agent)}
              disabled={stage === "starting"}
            >
              <RefreshCw className="size-3.5" /> Get a new code
            </Button>
          )}
          {ready && !isDevice && (
            <Button
              onClick={() => submit(callback.trim())}
              disabled={!callback.trim() || stage === "submitting"}
            >
              {stage === "submitting" ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" /> Completing…
                </>
              ) : (
                "Complete sign-in"
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
