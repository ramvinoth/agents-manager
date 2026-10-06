// Integrations — the app half of viewer/integrations.py (twin of web/src/lib/integrations.ts). The server owns
// the catalog (providers, services, scopes) and every rule; it sends one view
// (GET /api/integrations) and this module only turns a service's state into
// the control the owner sees, and runs the consent wait both the
// Integrations page and the file browser's location picker use.
import type { IntegrationConnection, IntegrationProvider, IntegrationService, ServiceState } from "../api/client"

/** What tapping a service row does. `toggle` flips the owner's switch (the
 *  grant is untouched); `grant` runs consent for the missing permission;
 *  `none` is Keep-style "listed so you know, not connectable". */
export type ServiceAction = "toggle" | "grant" | "none"

export function serviceAction(state: ServiceState): ServiceAction {
  if (state === "on" || state === "off") return "toggle"
  if (state === "grant") return "grant"
  return "none"
}

/** The service an expired account's Reconnect consents for. Any one will do —
 *  the server's consent re-asks for every scope the account already holds —
 *  so prefer one the owner has on, else the first connectable one. */
export function reconnectService(p: IntegrationProvider, c: IntegrationConnection): string {
  const usable = p.services.filter((s) => s.available)
  return (usable.find((s) => c.services[s.id] === "on") || usable[0]).id
}

/** What an unconfigured provider unlocks once its one-time client setup is done. */
export function setupHint(p: IntegrationProvider): string {
  const names = p.services.filter((s) => s.available).map((s) => s.label)
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0]
  return `Set up once, then connect your ${list}.`
}

/** The first message of a "Try it in a chat" session: the service's sample
 *  task, pinned to this account when it has a name — with several accounts
 *  connected the agent would otherwise have to ask which one. */
export function tryPrompt(s: IntegrationService, c: IntegrationConnection): string {
  return c.account ? `${s.try} Use my ${s.label} account ${c.account}.` : s.try
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
