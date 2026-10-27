// Integrations — the app half of viewer/integrations.py (twin of web/src/lib/integrations.ts). The server owns
// the catalog (providers, services, scopes) and every rule; it sends one view
// (GET /api/integrations) and this module only turns a service's state into
// the control the owner sees, and runs the consent wait both the
// Integrations page and the file browser's location picker use.
import type { IntegrationCategory, IntegrationConnection, IntegrationProvider, IntegrationService, ServiceState } from "../api/client"

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

/** The one line a collapsed service row shows: what agents may do there now,
 *  so the owner reads the whole account at a glance and opens a row only to
 *  change it. */
export function serviceSummary(s: IntegrationService, c: IntegrationConnection): string {
  const state = c.services[s.id] || "grant"
  if (state === "unavailable") return "Not available"
  if (state === "grant") return "Not connected yet" // the row's own button says how
  if (state === "off") return "Off"
  const may = s.ops.filter((o) => c.ops[s.id]?.[o.id] === "on").map((o) => o.label)
  const what = s.ops.length ? (may.length ? may.join(", ") : "Nothing allowed") : "On"
  return s.kind === "files" && c.root && c.root !== "/" ? `${what} · only ${c.root}` : what
}

/** One quiet line for the services a provider lists but nobody can connect
 *  (Google Keep has no API) — said once, not as a dead row per account. */
export function unavailableNote(p: IntegrationProvider): string {
  return p.services.filter((s) => !s.available).map((s) => `${s.label} can't be connected: ${s.unavailable.replace(/\.$/, "")}.`).join(" ")
}

/** Whether an account is connected by pasting an API token rather than a sign-in. */
export const isToken = (p: IntegrationProvider): boolean => p.auth === "token"

/** A provider nobody can connect yet (AWS needs request signing): listed so the
 *  owner knows it is coming, with the reason in place of a button. */
export const comingLater = (p: IntegrationProvider): boolean => !p.services.some((s) => s.available)

/** "Add an account" grouped the way the server orders it. Providers whose
 *  category the server did not list (or an older server sending none) land in
 *  the first group, so nothing is ever hidden. Empty groups are dropped. */
export function byCategory(providers: IntegrationProvider[], categories: IntegrationCategory[] = []):
  (IntegrationCategory & { providers: IntegrationProvider[] })[] {
  const cats = categories.length ? categories : [{ id: "workspace", label: "Files, mail & calendar" }]
  const known = new Set(cats.map((c) => c.id))
  return cats
    .map((c) => ({ ...c, providers: providers.filter((p) => (known.has(p.category || "") ? p.category : cats[0].id) === c.id) }))
    .filter((g) => g.providers.length)
}

/** The one line a closed category shows: what can be connected now, and how
 *  many more are only listed. */
export function categorySummary(providers: IntegrationProvider[]): string {
  const ready = providers.filter((p) => !comingLater(p)).map((p) => p.label)
  const later = providers.length - ready.length
  return [ready.join(", "), later ? `${later} coming later` : ""].filter(Boolean).join(" · ")
}

/** What an unconfigured provider unlocks once its one-time client setup is done. */
export function setupHint(p: IntegrationProvider): string {
  const names = p.services.filter((s) => s.available).map((s) => s.label)
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0]
  return `Set up once, then connect your ${list}.`
}

/** Whether a provider's row under "Add an account" shows its service chips.
 *  Adding is the whole page until the first account exists, so every ready
 *  provider starts open; after that it is a rare act, so a row opens only when
 *  the owner taps it (`chosen`) and the page stays about the accounts. */
export function providerOpen(p: IntegrationProvider, chosen: string | null, hasAccounts: boolean): boolean {
  return !isToken(p) && p.client.configured && (chosen === p.id || !hasAccounts)
}

/** The one line under a provider's name: what setup unlocks, what to do once
 *  open, or (closed) what it offers. */
export function providerHint(p: IntegrationProvider, open: boolean): string {
  if (comingLater(p)) return p.services[0]?.unavailable || "Not connectable yet."
  if (isToken(p)) return p.services.find((s) => s.available)?.agent || ""
  if (!p.client.configured) return `${p.client.client_id ? "Client secret missing. " : ""}${setupHint(p)}`
  if (open) return "Pick what to start with. You can add the rest later."
  return p.services.filter((s) => s.available).map((s) => s.label).join(", ")
}

/** The providers "Add an account" folds behind one "More services" row: those
 *  still needing their one-time developer setup, once some provider is ready
 *  to sign in. Setup is a developer chore most owners never do, so it should
 *  not crowd the providers they can use now; with none ready, setup IS the
 *  way in, so nothing folds. */
export function setupFold(providers: IntegrationProvider[]): IntegrationProvider[] {
  const oauth = providers.filter((p) => !isToken(p))
  return oauth.some((p) => p.client.configured) ? oauth.filter((p) => !p.client.configured) : []
}

/** A folder as the owner reads it: "~" is their home folder, not a symbol. */
export function folderLabel(root: string): string {
  return root === "~" || root === "~/" ? "Home folder" : root
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
