// Agents link the files they write the way a README does — relative to their
// working folder ("[report](docs/report.md)") or absolute ("/srv/x.md",
// "~/x.md", "file:///srv/x.md"). This turns such a link into the path the
// Files API reads, or null when it is not a file link (a URL, a mail link, an
// in-page anchor) or cannot be placed (relative, but the session's folder is
// unknown). Pure string work, so a transcript pays nothing until a link is
// tapped. Mirrored in mobile-app/src/lib/fileLink.ts.

/** The file path `href` points at, resolved against the session's `cwd`. */
export function fileLinkPath(href: string, cwd?: string | null): string | null {
  let p = href.trim()
  if (p.startsWith("<") && p.endsWith(">")) p = p.slice(1, -1).trim() // [x](<a b.md>)
  if (/^file:\/\//i.test(p)) {
    p = p.replace(/^file:\/\/(localhost)?/i, "")
    try { p = decodeURI(p) } catch { return null }
  } else if (!p || /^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith("#") || p.startsWith("//")) {
    return null
  }
  p = p.replace(/[?#].*$/, "") // "#L12" / "?plain=1" are viewer hints, not part of the name
  if (!p) return null
  if (!p.startsWith("/") && !p.startsWith("~")) {
    if (!cwd) return null
    p = cwd.replace(/\/+$/, "") + "/" + p
  }
  return normalize(p)
}

/** Collapse "." and ".." segments; ".." never climbs above the root. */
function normalize(p: string): string {
  const abs = p.startsWith("/")
  const out: string[] = []
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue
    if (seg === "..") {
      if (out.length && out[out.length - 1] !== "~") out.pop()
    } else out.push(seg)
  }
  return (abs ? "/" : "") + out.join("/")
}

/** The folder holding `path` and its own name, for finding its entry in a listing. */
export function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf("/")
  if (i < 0) return { dir: "~", name: path }
  return { dir: i === 0 ? "/" : path.slice(0, i), name: path.slice(i + 1) }
}
