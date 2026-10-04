import { useCallback, useEffect, useMemo, useState } from "react"
import { Loader2 } from "lucide-react"
import { renderSVG } from "uqr"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { api } from "@/lib/api"
import { buildPairLink, unreachableReason } from "@/lib/pairLink"

// The address a phone uses can differ from the one this tab is on (localhost on
// the box itself), so it is editable and remembered per browser.
const URL_KEY = "pairServerUrl"

/**
 * Pair a phone: shows a QR of a one-time sign-in link. Scanning it with the
 * iPhone Camera opens the Harman app, which adds this server and signs in as
 * you — no password typed on the phone. The code is single-use and expires in
 * five minutes; the dialog counts down and offers a fresh one.
 */
export function PairPhoneDialog({ onClose }: { onClose: () => void }) {
  const [serverUrl, setServerUrl] = useState(() => localStorage.getItem(URL_KEY) || window.location.origin)
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null)
  const [error, setError] = useState("")
  const [now, setNow] = useState(() => Date.now() / 1000)
  const [copied, setCopied] = useState(false)

  const mint = useCallback(() => {
    setError("")
    setCode(null)
    api.pairStart().then(setCode, (e: Error) => setError(e.message))
  }, [])
  useEffect(mint, [mint])
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), 1000)
    return () => clearInterval(t)
  }, [])

  const problem = unreachableReason(serverUrl)
  const left = code ? Math.max(0, Math.round(code.expiresAt - now)) : 0
  const link = code && !problem ? buildPairLink(serverUrl, code.code) : ""
  const qr = useMemo(
    () => (link ? `data:image/svg+xml;utf8,${encodeURIComponent(renderSVG(link, { border: 2 }))}` : ""),
    [link]
  )

  function saveUrl(v: string) {
    setServerUrl(v)
    localStorage.setItem(URL_KEY, v.trim())
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pair a phone</DialogTitle>
          <DialogDescription>
            Scan with the iPhone Camera. The Harman app opens and signs in as you — no password needed.
          </DialogDescription>
        </DialogHeader>

        <label className="text-[11px] text-muted-foreground">
          Address your phone uses to reach this server
          <Input value={serverUrl} onChange={(e) => saveUrl(e.target.value)} spellCheck={false} className="mt-1" />
        </label>

        <div className="flex min-h-56 items-center justify-center">
          {error ? (
            <p className="text-center text-xs text-destructive">{error}</p>
          ) : problem ? (
            <p className="text-center text-xs text-destructive">{problem}</p>
          ) : !code ? (
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          ) : left === 0 ? (
            <div className="text-center">
              <p className="mb-2 text-xs text-muted-foreground">This code expired.</p>
              <Button size="sm" onClick={mint}>New code</Button>
            </div>
          ) : (
            <img src={qr} alt="Pairing QR code" className="size-56 rounded-md bg-white" />
          )}
        </div>

        {link && left > 0 && (
          <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span>
              Works once · expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
            </span>
            <button
              className="underline hover:text-foreground"
              onClick={() => navigator.clipboard?.writeText(link).then(() => setCopied(true), () => {})}
            >
              {copied ? "Copied" : "Copy link"}
            </button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
