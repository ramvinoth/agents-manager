import { useCallback, useEffect, useMemo, useState } from "react"
import { Loader2 } from "lucide-react"
import { renderSVG } from "uqr"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { api } from "@/lib/api"
import { buildPairLink, type RelayOffer, unreachableReason } from "@/lib/pairLink"

// The address a phone uses can differ from the one this tab is on (localhost on
// the box itself). Precedence: what the user typed here (remembered per browser)
// > the server's configured public address (HARMAN_PUBLIC_URL) > this tab's origin.
const URL_KEY = "pairServerUrl"

/**
 * Pair a phone: shows a QR of a one-time sign-in link. Scanning it with the
 * iPhone Camera opens the Harman app, which adds this server and signs in as
 * you — no password typed on the phone. The code is single-use and expires in
 * five minutes; the dialog counts down and offers a fresh one.
 *
 * When the server runs the Harman relay (pair/start returns `relay`), the QR
 * also carries the relay route, so a phone pairs even when this server has no
 * address it can reach — the direct address becomes optional, not a blocker.
 */
export function PairPhoneDialog({ onClose }: { onClose: () => void }) {
  const [typedUrl, setTypedUrl] = useState(() => localStorage.getItem(URL_KEY) || "")
  const [publicUrl, setPublicUrl] = useState("")
  const [relay, setRelay] = useState<RelayOffer | null>(null)
  const serverUrl = typedUrl || publicUrl || window.location.origin
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null)
  const [error, setError] = useState("")
  const [now, setNow] = useState(() => Date.now() / 1000)
  const [copied, setCopied] = useState(false)

  const mint = useCallback(() => {
    setError("")
    setCode(null)
    api.pairStart().then(
      (r) => {
        setCode(r)
        setPublicUrl(r.publicUrl || "")
        setRelay(r.relay || null)
      },
      (e: Error) => setError(e.message)
    )
  }, [])
  useEffect(mint, [mint])
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), 1000)
    return () => clearInterval(t)
  }, [])

  const problem = unreachableReason(serverUrl)
  const left = code ? Math.max(0, Math.round(code.expiresAt - now)) : 0
  // A direct address the phone can't use is left out; the relay still gets it there.
  const direct = problem ? "" : serverUrl
  const link = code && (direct || relay) ? buildPairLink(direct, code.code, relay) : ""
  const qr = useMemo(
    () => (link ? `data:image/svg+xml;utf8,${encodeURIComponent(renderSVG(link, { border: 2 }))}` : ""),
    [link]
  )

  // Clearing the field drops the override, so the server's address applies again.
  function saveUrl(v: string) {
    setTypedUrl(v)
    if (v.trim()) localStorage.setItem(URL_KEY, v.trim())
    else localStorage.removeItem(URL_KEY)
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
          Address your phone uses to reach this server{relay ? " (optional — the relay works without one)" : ""}
          <Input value={serverUrl} onChange={(e) => saveUrl(e.target.value)} spellCheck={false} className="mt-1" />
        </label>

        <div className="flex min-h-56 items-center justify-center">
          {error ? (
            <p className="text-center text-xs text-destructive">{error}</p>
          ) : problem && !relay ? (
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

        {link && left > 0 && relay && (
          <p className="text-[11px] text-muted-foreground">
            {direct
              ? "Your phone uses this address when it can, and the Harman relay everywhere else."
              : "Your phone connects through the Harman relay."}{" "}
            The relay only passes along encrypted traffic; it can't read it.
          </p>
        )}

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
