/** Where a chat's turns run (orchestrator/runtime/backends.RUNTIMES). The keys are
 *  wire values; a person reads RUNTIME_NAME. Only chats on the server's own machine
 *  choose: a chat on another host always runs on that host. The web twin of
 *  mobile-app/src/lib/runtime.ts (the apps share no package); keep them in step. */
export type Runtime = "local" | "sandbox"
export const RUNTIMES: readonly Runtime[] = ["local", "sandbox"]

export const RUNTIME_NAME: Record<Runtime, string> = { local: "Server", sandbox: "Cloud sandbox" }

/** The pill choices: "" = no choice stored, the server's default_runtime applies. */
export const RUNTIME_OPTIONS: { v: Runtime | ""; label: string }[] = [
  { v: "", label: "Server default" },
  ...RUNTIMES.map((v) => ({ v, label: RUNTIME_NAME[v] })),
]

export function isRuntime(v: unknown): v is Runtime {
  return typeof v === "string" && (RUNTIMES as readonly string[]).includes(v)
}

/** One line for the card header: what applies, and whether this chat chose it. */
export function runtimeSummary(stored: string, effective: string): string {
  if (!isRuntime(effective)) return "Loading…"
  return `${RUNTIME_NAME[effective]}${isRuntime(stored) ? "" : " (server default)"}`
}

/** Read a save reply: the server must echo the runtime it stored. */
export function runtimeSaved(reply: unknown, want: Runtime | ""): boolean {
  const r = reply as { saved?: unknown; runtime?: unknown } | null
  return !!r && r.saved === true && (r.runtime ?? "") === want
}
