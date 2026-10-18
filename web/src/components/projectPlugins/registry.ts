import { useEffect, useState } from "react"
import { type LucideIcon, AppWindow, BookOpenText } from "lucide-react"
import { api } from "@/lib/api"
import type { ProjectPlugin } from "@/lib/types"

/** The icons a project plugin may name (viewer/project_plugins.py `icon`).
 *  The server owns which plugins exist; the web only draws them. */
const ICONS: Record<string, LucideIcon> = { BookOpenText }

export const pluginIcon = (name: string): LucideIcon => ICONS[name] ?? AppWindow

// One read per page load: plugins turn on through the server's env, which
// only changes across a server restart.
let loaded: Promise<ProjectPlugin[]> | null = null

/** The project plugins this server has on — rows beside Tasks/Notes/Inbox/Map. */
export function useProjectPlugins(): ProjectPlugin[] {
  const [plugins, setPlugins] = useState<ProjectPlugin[]>([])
  useEffect(() => {
    let live = true
    loaded ??= api.projectPlugins().then((r) => r.plugins ?? []).catch(() => {
      loaded = null // a failed read retries on the next mount, never sticks empty
      return []
    })
    loaded.then((p) => live && setPlugins(p))
    return () => {
      live = false
    }
  }, [])
  return plugins
}
