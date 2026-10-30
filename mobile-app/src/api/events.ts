/**
 * The live-events stream (lib/liveEvents) for the ACTIVE server, opened
 * through the same transport as every other socket — direct address or the
 * Harman relay, whichever answers (api/transport.ts). One stream per server:
 * after a switch, the old one closes on its own once its screens let go.
 */
import { LiveStream } from "../lib/liveEvents"
import { activeServerId } from "../state/config"
import { serverSocket } from "./transport"

const streams = new Map<string, LiveStream>()

export function liveEvents(): LiveStream {
  const id = activeServerId() || ""
  let s = streams.get(id)
  if (!s) {
    s = new LiveStream(() => serverSocket("/api/events/ws"))
    streams.set(id, s)
  }
  return s
}
