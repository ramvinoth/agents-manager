/** Pure helpers and constants shared by the slices. */
import { api } from "../lib/api"
import type { HostInfo, SessionListItem, Turn } from "../lib/types"

export const TAIL_LINES = 400
export const CHUNK_LINES = 400

export function sessionIdOf(path: string): string {
  return path ? path.split("/").pop()!.replace(".jsonl", "") : ""
}

export function turnText(t: Turn): string {
  if (t.type === "assistant")
    return t.blocks.map((b) => (b.type === "text" ? b.text : b.name)).join(" ")
  return t.content
}

export function pickOpen(sessions: SessionListItem[], host: string): string | undefined {
  const last = localStorage.getItem("lastSession:" + host)
  return last && sessions.some((s) => s.path === last) ? last : sessions[0]?.path
}

export async function reloadForHost(): Promise<{ hosts: HostInfo[]; sessions: SessionListItem[] }> {
  const hosts = (await api.hosts()) as HostInfo[]
  const sessions = (await api.sessions()) as SessionListItem[]
  if (!Array.isArray(sessions)) throw new Error((sessions as any).error || "host error")
  return { hosts, sessions }
}

