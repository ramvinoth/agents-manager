import { useState } from "react"
import { LogIn, ExternalLink } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useStore } from "@/store"

export function LoginPanel() {
  const loginActive = useStore((s) => s.loginActive)
  const loginUrl = useStore((s) => s.loginUrl)
  const loginNote = useStore((s) => s.loginNote)
  const startLogin = useStore((s) => s.startLogin)
  const submitLoginCode = useStore((s) => s.submitLoginCode)
  const cancelLogin = useStore((s) => s.cancelLogin)
  const [code, setCode] = useState("")

  function submit() {
    submitLoginCode(code)
    setCode("")
  }

  return (
    <div className="border-t border-border bg-background p-3">
      <div className="mx-auto max-w-3xl rounded-lg border border-border p-4">
        {!loginActive ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm">
              <div className="font-medium">Not logged in</div>
              <div className="text-xs text-muted-foreground">
                Log in with your Claude account to start chatting.
              </div>
            </div>
            <Button onClick={startLogin}>
              <LogIn className="size-4" /> Log in with Claude
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {loginNote && <div className="text-sm text-muted-foreground">{loginNote}</div>}
            {loginUrl && (
              <>
                <a
                  href={loginUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm text-primary underline"
                >
                  <ExternalLink className="size-3.5" /> Open login page
                </a>
                <div className="flex gap-2">
                  <Input
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="Paste the code from the login page"
                    onKeyDown={(e) => e.key === "Enter" && submit()}
                    autoFocus
                  />
                  <Button onClick={submit}>Submit</Button>
                </div>
              </>
            )}
            <Button variant="ghost" size="sm" onClick={cancelLogin}>
              Cancel
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
