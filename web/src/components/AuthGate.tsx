import { useState } from "react"
import { Lock, ArrowRight, Loader2, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useStore } from "@/store"

/** The logged-out landing: sign in, or (first run, no users yet) create the
 * owner account. Drag-drop viewing stays available without an account. */
export function AuthGate() {
  const signupOpen = useStore((s) => s.signupOpen)
  const signin = useStore((s) => s.signin)
  const signup = useStore((s) => s.signup)
  const loadDroppedFile = useStore((s) => s.loadDroppedFile)

  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [err, setErr] = useState("")
  const [busy, setBusy] = useState(false)

  async function submit() {
    if (!username.trim() || !password || busy) return
    setBusy(true)
    setErr("")
    const msg = await (signupOpen ? signup : signin)(username.trim(), password)
    if (msg) {
      setErr(msg)
      setBusy(false)
    }
    // On success the store sets needsAuth=false and this view unmounts.
  }

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div className="w-full max-w-xs">
        <div className="mb-6 flex flex-col items-center text-center">
          <span className="mb-3 flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Lock className="size-5" />
          </span>
          <h1 className="text-base font-semibold">{signupOpen ? "Create your account" : "Sign in"}</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {signupOpen
              ? "First run — this account owns the instance."
              : "This viewer is private to your account."}
          </p>
        </div>

        <form
          className="flex flex-col gap-2.5"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Username or email"
            autoFocus
            autoComplete="username"
            spellCheck={false}
          />
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            autoComplete={signupOpen ? "new-password" : "current-password"}
          />
          {err && <p className="text-xs text-destructive">{err}</p>}
          <Button type="submit" disabled={busy || !username.trim() || !password} className="mt-1 gap-1.5">
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <>
                {signupOpen ? "Create account" : "Sign in"} <ArrowRight className="size-4" />
              </>
            )}
          </Button>
        </form>

        <div className="mt-6 flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="h-px flex-1 bg-border" /> or view without an account <span className="h-px flex-1 bg-border" />
        </div>
        <label className="mt-3 flex cursor-pointer flex-col items-center gap-1.5 rounded-lg border border-dashed border-border px-4 py-5 text-center transition-colors hover:border-primary/60 hover:bg-accent/40">
          <input
            type="file"
            accept=".jsonl,.json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) loadDroppedFile(f)
            }}
          />
          <Upload className="size-5 text-muted-foreground" />
          <span className="text-xs font-medium">
            Drop or choose a <span className="font-mono">.jsonl</span> session
          </span>
          <span className="text-[11px] text-muted-foreground">Renders locally — nothing leaves your browser</span>
        </label>
      </div>
    </div>
  )
}
