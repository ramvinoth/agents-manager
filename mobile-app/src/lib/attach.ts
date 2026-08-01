/**
 * Sharing a screenshot with the agent.
 *
 * The chat endpoint takes text only — it has no image/attachment field. But the
 * agent runs on the host and can READ files, and /api/fs/upload accepts
 * multipart uploads to a host directory. So: upload the picture, then mention
 * its path in the message. The agent opens it with its own Read tool.
 *
 * Both native modules are loaded defensively; on a build without them the
 * attach button simply reports that it needs a newer build rather than crashing.
 *
 * NOTE: this module deliberately imports NOTHING from app state — the server URL
 * and token are passed in. Importing state/config pulled in expo-secure-store,
 * which made the whole module impossible to unit-test in Node.
 */

// Uploads land in a folder under the home dir on the HOST. The server refuses
// to upload into a directory that doesn't exist, so we create it first.
const UPLOAD_PARENT = "~"
const UPLOAD_NAME = "agents-uploads"
const UPLOAD_DIR = `${UPLOAD_PARENT}/${UPLOAD_NAME}`

export type Picked = { uri: string; name: string }

/** Open the photo library. Returns null if cancelled or unavailable. */
export async function pickImage(): Promise<Picked | null> {
  let ImagePicker: any
  try {
    ImagePicker = require("expo-image-picker")
  } catch {
    throw new Error("Image picking needs a newer build of the app.")
  }
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync()
  if (!perm.granted) throw new Error("Photo access was denied.")
  const res = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ImagePicker.MediaTypeOptions?.Images ?? "images",
    quality: 0.8,
  })
  if (res.canceled || !res.assets?.length) return null
  const a = res.assets[0]
  const name = a.fileName || `upload-${Date.now()}.jpg`
  return { uri: a.uri, name }
}

/** Fallback path if the server response omits one. Prefer the server's value:
 *  it is absolute, whereas this keeps the leading "~" which the agent's file
 *  tools may not expand. */
export function uploadedPath(name: string, dir = UPLOAD_DIR): string {
  return `${dir}/${name}`
}

/** Pull the RESOLVED ABSOLUTE path out of an /api/fs/upload response. */
export function pathFromUploadResponse(res: unknown, fallbackName: string): string {
  const first = (res as any)?.uploaded?.[0]
  if (first?.error) throw new Error(String(first.error))
  return first?.path || uploadedPath(fallbackName)
}

/**
 * Upload to the host via multipart. Returns the remote path to mention in chat.
 * Uses fetch + FormData: React Native turns {uri,name,type} into a file part.
 */
export async function uploadImage(
  opts: { base: string; token: string; host: string },
  file: Picked,
  dir = UPLOAD_DIR
): Promise<string> {
  const { base, token, host } = opts
  if (!base) throw new Error("No server configured")
  const form = new FormData()
  // RN's FormData accepts this shape for a local file URI.
  form.append("files", { uri: file.uri, name: file.name, type: guessMime(file.name) } as any)

  // Ensure the target exists — the server 400s on a missing directory. Creating
  // an existing folder is harmless, so the result is ignored.
  await fetch(`${base}/api/fs/mkdir`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ path: UPLOAD_PARENT, name: UPLOAD_NAME, host }),
  }).catch(() => {})

  const q = new URLSearchParams({ path: dir })
  if (host && host !== "local") q.set("host", host)
  const res = await fetch(`${base}/api/fs/upload?${q.toString()}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` }, // no Content-Type: fetch sets the boundary
    body: form,
  })
  if (!res.ok) throw new Error(`Upload failed (HTTP ${res.status})`)
  // Use the server's absolute path — a "~" prefix may not expand for the agent.
  return pathFromUploadResponse(await res.json().catch(() => null), file.name)
}

export function guessMime(name: string): string {
  const ext = (name.split(".").pop() || "").toLowerCase()
  if (ext === "png") return "image/png"
  if (ext === "gif") return "image/gif"
  if (ext === "webp") return "image/webp"
  if (ext === "heic") return "image/heic"
  return "image/jpeg"
}

/** The message text that points the agent at the uploaded file. */
export function attachMessage(path: string, note: string): string {
  const body = note.trim()
  return body ? `${body}\n\n(Image attached at ${path})` : `Take a look at the image at ${path}`
}
