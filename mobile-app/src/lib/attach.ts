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

export type Picked = { uri: string; name: string; mime?: string }

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

/** One upload: make sure the target exists, send the file, return the server's path. */
async function upload(files: HostFiles, host: string, file: Picked, mime: string, dir: string): Promise<string> {
  const scope = host && host !== "local" ? { host } : {}
  // Ensure the target exists — the server 400s on a missing directory. Creating
  // an existing folder is refused harmlessly, so the result is ignored.
  await files.fsMkdir(scope, { path: UPLOAD_PARENT, name: UPLOAD_NAME }).catch(() => {})
  const res = await files.fsUpload(scope, dir, file.uri, file.name, mime)
  // Use the server's absolute path — a "~" prefix may not expand for the agent.
  return pathFromUploadResponse(res, file.name)
}

/** Upload a picture to the host. Returns the remote path to mention in chat. */
export function uploadImage(files: HostFiles, host: string, file: Picked, dir = UPLOAD_DIR): Promise<string> {
  return upload(files, host, file, guessMime(file.name), dir)
}

/** Upload any file (video, audio, PDF, anything). The server overwrites a file of
 *  the same name, so the name is made unique first. */
export function uploadFile(files: HostFiles, host: string, file: Picked, dir = UPLOAD_DIR): Promise<string> {
  const named = { ...file, name: uniqueName(file.name) }
  return upload(files, host, named, file.mime || mimeFor(file.name), dir)
}

/** Prefix a timestamp and keep only characters every host filesystem accepts. */
export function uniqueName(name: string, now = Date.now()): string {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/\.{2,}/g, ".").replace(/^[._]+/, "") || "file"
  return `${now}-${safe}`
}

const MIME: Record<string, string> = {
  mp4: "video/mp4", mov: "video/quicktime", m4v: "video/x-m4v",
  m4a: "audio/mp4", mp3: "audio/mpeg", wav: "audio/wav", aac: "audio/aac",
  pdf: "application/pdf", txt: "text/plain", json: "application/json", csv: "text/csv",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic",
}

/** Best MIME for any file name. Unknown types go up as raw bytes: no extension is refused. */
export function mimeFor(name: string): string {
  const ext = (name.split(".").pop() || "").toLowerCase()
  return MIME[ext] || "application/octet-stream"
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

/** The message text for a non-image file (video, audio, PDF, anything). */
export function fileMessage(path: string, note: string): string {
  const body = note.trim()
  return body ? `${body}\n\n(File attached at ${path})` : `Take a look at the file at ${path}`
}

/** Photos and videos, from the library or straight from the camera. Null if cancelled. */
export async function pickMedia(source: "library" | "camera"): Promise<Picked | null> {
  let ImagePicker: any
  try {
    ImagePicker = require("expo-image-picker")
  } catch {
    throw new Error("Attaching media needs a newer build of the app.")
  }
  const { Platform } = require("react-native")
  const opts = { mediaTypes: ImagePicker.MediaTypeOptions?.All ?? "all", quality: 0.8 }
  let res: any
  if (source === "camera") {
    const perm = await ImagePicker.requestCameraPermissionsAsync()
    if (!perm.granted) throw new Error("Camera access was denied.")
    res = await ImagePicker.launchCameraAsync(opts)
  } else {
    // Android's system photo picker needs no permission (plugins/withAndroidPermissions.js does not declare READ_MEDIA_*).
    if (Platform.OS !== "android") {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync()
      if (!perm.granted) throw new Error("Photo access was denied.")
    }
    res = await ImagePicker.launchImageLibraryAsync(opts)
  }
  if (res.canceled || !res.assets?.length) return null
  const a = res.assets[0]
  const ext = (a.uri.split(".").pop() || "").split("?")[0] || (a.type === "video" ? "mov" : "jpg")
  return { uri: a.uri, name: a.fileName || `upload-${Date.now()}.${ext}`, mime: a.mimeType }
}

/** Any file from the Files app (audio, PDF, anything). Null if cancelled. */
export async function pickFile(): Promise<Picked | null> {
  let DocumentPicker: any
  try {
    DocumentPicker = require("expo-document-picker")
  } catch {
    throw new Error("Picking files needs a newer build of the app.")
  }
  const res = await DocumentPicker.getDocumentAsync({ type: "*/*", copyToCacheDirectory: true })
  if (res.canceled || !res.assets?.length) return null
  const a = res.assets[0]
  return { uri: a.uri, name: a.name || `file-${Date.now()}`, mime: a.mimeType }
}
