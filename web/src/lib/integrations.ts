// Integrations — the client half of viewer/integrations.py (twin of mobile-app/src/lib/integrations.ts). The server owns
// the catalog (providers, services, scopes) and every rule; it sends one view
// (GET /api/integrations) and this module only turns a service's state into
// the control the owner sees, and runs the consent wait both the
// Integrations page and the file browser's location picker use.
import type { ServiceState } from "./types"

/** What tapping a service row does. `toggle` flips the owner's switch (the
 *  grant is untouched); `grant` runs consent for the missing permission;
 *  `none` is Keep-style "listed so you know, not connectable". */
export type ServiceAction = "toggle" | "grant" | "none"

export function serviceAction(state: ServiceState): ServiceAction {
  if (state === "on" || state === "off") return "toggle"
  if (state === "grant") return "grant"
  return "none"
}

export type ConsentStatus = { status: "waiting" | "authorized" | "failed" | "expired"; error?: string }

/** Poll an in-flight consent until it ends. Resolves on `authorized`; rejects
 *  with the server's reason on failed/expired. `cancelled()` lets a closed
 *  dialog stop polling without leaving a timer behind. */
export async function waitForConsent(
  poll: () => Promise<ConsentStatus>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  cancelled: () => boolean = () => false,
  intervalMs = 2000,
): Promise<void> {
  for (;;) {
    if (cancelled()) throw new Error("Cancelled")
    const s = await poll()
    if (s.status === "authorized") return
    if (s.status !== "waiting") throw new Error(s.error || `Consent ${s.status}`)
    await sleep(intervalMs)
  }
}
