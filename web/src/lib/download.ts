// Saving a file in the browser — ONE helper for every download the web app makes
// (file browser, note export, mermaid diagrams).

/** Hand a blob to the browser as a download named `name`. */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Fetch first, then save: a bare <a download> shows no progress while the server
 *  works (a PDF takes seconds) and would write the server's JSON error to disk under
 *  the file's name. Pass `get` = api.getRes so a 401 signs out. Throws an Error carrying `status` and the server's error text. */
export async function fetchAndSave(href: string, name: string, get: (href: string) => Promise<Response> = fetch): Promise<void> {
  const res = await get(href)
  if (!res.ok) {
    const d = await res.json().catch(() => null)
    throw Object.assign(new Error(d?.error || `HTTP ${res.status}`), { status: res.status })
  }
  saveBlob(await res.blob(), name)
}
