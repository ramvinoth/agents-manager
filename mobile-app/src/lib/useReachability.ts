import { useEffect, useState } from "react"
import { reachability, type ReachState } from "./reachability"

/** The live "can the app reach its server" state (see lib/reachability). */
export function useReachability(): ReachState {
  const [state, setState] = useState(reachability.get())
  useEffect(() => reachability.subscribe(setState), [])
  return state
}
