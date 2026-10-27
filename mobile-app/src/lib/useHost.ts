import { useEffect, useState } from "react"
import { api } from "../api/client"
import { currentHost, subscribeHost } from "../state/config"

export const LOCAL_LABEL = "This machine"

/**
 * The active machine every host-scoped screen works on: its id and friendly
 * label, live — a switch in Profile re-roots Chats/Files the moment it happens.
 * One copy of the id → label lookup (SSH hosts resolve from the host list).
 */
export function useHost(): { host: string; label: string } {
  const [host, setHost] = useState(currentHost())
  const [label, setLabel] = useState(LOCAL_LABEL)
  useEffect(() => subscribeHost(() => setHost(currentHost())), [])
  useEffect(() => {
    let alive = true
    if (host === "local") { setLabel(LOCAL_LABEL); return }
    setLabel(host)
    api.hosts()
      .then((r) => { if (alive) setLabel(r.find((h) => h.id === host)?.label || host) })
      .catch(() => {})
    return () => { alive = false }
  }, [host])
  return { host, label }
}
