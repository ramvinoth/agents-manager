// Pure helpers for sending files to the agent from the composer. Same wording
// and naming rules as mobile-app/src/lib/attach.ts so both clients read alike.

export const UPLOAD_PARENT = "~"
export const UPLOAD_NAME = "agents-uploads"
export const UPLOAD_DIR = `${UPLOAD_PARENT}/${UPLOAD_NAME}`

/** The server overwrites same-named files, so every upload gets a unique name. */
export function uniqueName(name: string, now: number = Date.now()): string {
  const safe =
    name
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      .replace(/\.{2,}/g, ".")
      .replace(/^[._]+/, "") || "file"
  return `${now}-${safe}`
}

/** Appends one line per uploaded path to whatever the user already typed. */
export function withAttachments(text: string, paths: string[]): string {
  const lines = paths.map((p) => `(File attached at ${p})`)
  const base = text.trimEnd()
  return [base, ...lines].filter(Boolean).join("\n\n")
}
