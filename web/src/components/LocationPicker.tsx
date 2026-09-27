import { useEffect, useRef, useState } from "react"
import { Check, ChevronDown, Cloud, HardDrive, KeyRound, Loader2, Plus, Trash2 } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { api } from "@/lib/api"
import { IntegrationsDialog } from "@/components/IntegrationsDialog"
import { HOST_LOCATION, describeLocation, vendorLabel, type Location } from "@/lib/location"
import type { Drive } from "@/lib/types"

/**
 * LocationPicker — the file browser's "where am I looking" chip. One menu:
 * the current host (the app-wide choice from the header, shown as its label),
 * every connected cloud drive, and one "Add <vendor>" entry per vendor the
 * server can connect. Picking an unauthorized drive (never connected, or its
 * token was revoked) runs the consent flow before selecting it: the server
 * hands back a URL to open in a new tab and a handle to poll; the tab closes
 * itself on consent and the poll flips to `authorized`. A vendor with no
 * client on record cannot start consent (the server refuses with guidance);
 * that refusal opens the Integrations dialog where the client is entered, and
 * the same dialog is one menu entry away for later edits.
 *
 * Owns only the picker's transient state (the drive list, the in-flight
 * connect). The selected location belongs to the browser, which threads it
 * into every file call.
 */
export function LocationPicker({
  value,
  hostLabel,
  drives,
  vendors,
  onChange,
  onDrivesChange,
}: {
  value: Location
  hostLabel: string
  drives: Drive[]
  vendors: string[]
  onChange: (loc: Location) => void
  onDrivesChange: (drives: Drive[]) => void
}) {
  const [connecting, setConnecting] = useState<string | null>(null) // drive id mid-consent
  const [error, setError] = useState<string | null>(null)
  const [integrations, setIntegrations] = useState(false)
  const pollTimer = useRef<number | null>(null)

  useEffect(() => () => { if (pollTimer.current) window.clearTimeout(pollTimer.current) }, [])

  async function refresh(): Promise<Drive[]> {
    const d = await api.drives()
    onDrivesChange(d.drives || [])
    return d.drives || []
  }

  /** Run consent for `drive`, then select it. Polls every 2s until the flow
   *  ends; a failed/expired flow leaves the drive listed but unselected, with
   *  the reason shown — the user can retry from the same menu entry. */
  async function connect(drive: Drive) {
    setError(null)
    setConnecting(drive.id)
    try {
      const r = await api.driveOAuthStart(drive.id)
      if ("error" in r && r.error) {
        // "No <vendor> OAuth client configured …" — a setup gap, not a consent
        // failure: send the user to the form that fixes it.
        if (/OAuth client/.test(r.error)) setIntegrations(true)
        throw new Error(r.error)
      }
      if (!("url" in r)) throw new Error("No consent URL returned")
      window.open(r.url, "_blank", "noopener")
      const pending = r.pending
      await new Promise<void>((resolve, reject) => {
        const tick = async () => {
          try {
            const s = await api.driveOAuthStatus(pending)
            if (s.status === "authorized") return resolve()
            if (s.status === "waiting") {
              pollTimer.current = window.setTimeout(tick, 2000)
              return
            }
            reject(new Error(s.error || `Consent ${s.status}`))
          } catch (e) {
            reject(e)
          }
        }
        tick()
      })
      await refresh()
      onChange(drive.id)
    } catch (e: any) {
      setError(e?.message || String(e))
    }
    setConnecting(null)
  }

  async function add(kind: string) {
    setError(null)
    try {
      const r = await api.driveCreate({ label: vendorLabel(kind), kind })
      const created = r.drive
      onDrivesChange([...drives, created])
      await connect(created)
    } catch (e: any) {
      setError(e?.message || String(e))
    }
  }

  async function remove(drive: Drive) {
    if (!window.confirm(`Remove “${drive.label}”? Harman forgets its access token; nothing in the drive itself is touched.`)) return
    setError(null)
    try {
      const r = await api.driveDelete(drive.id)
      if ("error" in r && r.error) throw new Error(r.error)
      const rest = drives.filter((d) => d.id !== drive.id)
      onDrivesChange(rest)
      if (value === drive.id) onChange(HOST_LOCATION)
    } catch (e: any) {
      setError(e?.message || String(e))
    }
  }

  const label = describeLocation(value, drives, hostLabel)
  const onDrive = value !== HOST_LOCATION

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-6 max-w-56 gap-1 px-1.5 text-xs" disabled={!!connecting}>
            {connecting ? (
              <Loader2 className="size-3 animate-spin" />
            ) : onDrive ? (
              <Cloud className="size-3 text-muted-foreground" />
            ) : (
              <HardDrive className="size-3 text-muted-foreground" />
            )}
            <span className="truncate">{connecting ? "Waiting for consent…" : label}</span>
            <ChevronDown className="size-3 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-60">
          <DropdownMenuLabel>Location</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => onChange(HOST_LOCATION)} className="gap-1.5">
            <HardDrive className="size-3.5 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{hostLabel}</span>
            {!onDrive && <Check className="size-3.5 shrink-0" />}
          </DropdownMenuItem>
          {drives.map((d) => (
            <DropdownMenuItem
              key={d.id}
              onClick={() => (d.authorized ? onChange(d.id) : connect(d))}
              title={d.authorized ? vendorLabel(d.kind) : `${vendorLabel(d.kind)} — not connected yet, click to sign in`}
              className="gap-1.5"
            >
              <Cloud className="size-3.5 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{d.label}</span>
              {!d.authorized && <span className="text-[10px] text-muted-foreground">sign in</span>}
              {value === d.id && <Check className="size-3.5 shrink-0" />}
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  remove(d)
                }}
                className="text-muted-foreground hover:text-destructive"
                title="Remove drive"
              >
                <Trash2 className="size-3.5" />
              </button>
            </DropdownMenuItem>
          ))}
          {vendors.length > 0 && <DropdownMenuSeparator />}
          {vendors.map((k) => (
            <DropdownMenuItem key={k} onClick={() => add(k)} className="gap-1.5 text-muted-foreground">
              <Plus className="size-3.5" /> Add {vendorLabel(k)}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setIntegrations(true)} className="gap-1.5 text-muted-foreground">
            <KeyRound className="size-3.5" /> Integrations…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {error && <span className="truncate text-xs text-destructive" title={error}>{error}</span>}
      {integrations && <IntegrationsDialog onClose={() => setIntegrations(false)} />}
    </div>
  )
}
