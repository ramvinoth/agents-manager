import type { MapLevel, MapNode } from "../api/client"

/** Where clicking a Map node goes: a folder opens its level, a file its
 *  insides; a class or function is already the deepest level (null). */
export function drillTarget(n: MapNode): { level: MapLevel; path: string } | null {
  if (n.kind === "folder") return { level: "folder", path: n.id.replace(/\/$/, "") }
  if (n.kind === "file") return { level: "file", path: n.id }
  return null
}

/** The breadcrumb trail for a Map location: the project, then each folder,
 *  then the file. Every crumb is a location the map can open. */
export function crumbs(at: { level: MapLevel; path: string }, projectName: string) {
  const out: { level: MapLevel; path: string; label: string }[] = [
    { level: "project", path: "", label: projectName },
  ]
  const parts = at.level === "project" ? [] : at.path.split("/").filter(Boolean)
  parts.forEach((p, i) => {
    const isFile = at.level === "file" && i === parts.length - 1
    out.push({ level: isFile ? "file" : "folder", path: parts.slice(0, i + 1).join("/"), label: p })
  })
  return out
}
