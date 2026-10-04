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
 * NOTE: this module deliberately imports NOTHING from app state — the file
 * calls are passed in. Importing state/config pulled in expo-secure-store,
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

/** The two file calls an upload needs — `api` satisfies it. Injected so this
 *  module stays free of app state (see the header). */
export type HostFiles = {
  fsMkdir(scope: { host?: string }, body: { path: string; name: string }): Promise<unknown>
  fsUpload(scope: { host?: string }, dir: string, uri: string, name: string, mime?: string): Promise<unknown>
}

/**
 * Upload to the host. Returns the remote path to mention in chat.
 */
export async function uploadImage(files: HostFiles, host: string, file: Picked, dir = UPLOAD_DIR): Promise<string> {
  const scope = host && host !== "local" ? { host } : {}
  // Ensure the target exists — the server 400s on a missing directory. Creating
  // an existing folder is refused harmlessly, so the result is ignored.
  await files.fsMkdir(scope, { path: UPLOAD_PARENT, name: UPLOAD_NAME }).catch(() => {})
  const res = await files.fsUpload(scope, dir, file.uri, file.name, guessMime(file.name))
  // Use the server's absolute path — a "~" prefix may not expand for the agent.
  return pathFromUploadResponse(res, file.name)
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
