/** The shared project canvas: client half of the room protocol (orchestrator/canvas_room.py).
 *  Pure logic only — components/canvas/ProjectCanvas wires it to Excalidraw and the socket.
 *
 *  The server holds the truth. `known` is what we believe it holds (id → version):
 *  anything in the scene with a higher version is unsent, so a reconnect needs no
 *  resend queue — refetch the snapshot, reset `known`, and the diff resends the rest. */

export const PROTOCOL = 1
export const MAX_BATCH = 2000          // orchestrator/routes/canvas_board.MAX_BATCH

export interface El {
  id: string
  version: number
  versionNonce: number
  isDeleted?: boolean
  type?: string
  fileId?: string | null
  [k: string]: unknown
}

/** 32-bit FNV-1a over UTF-8 — the same number orchestrator/canvas_reconcile.fnv1a computes. */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5
  for (const b of new TextEncoder().encode(text)) h = Math.imul(h ^ b, 0x01000193) >>> 0
  return h
}

/** Scene fingerprint over live elements (tombstones left out, as on the server). */
export function checksum(els: readonly El[]): number {
  const pairs = els.filter((e) => !e.isDeleted).map((e) => `${e.id}:${e.version | 0}`)
  pairs.sort()
  return fnv1a(pairs.join(","))
}

/** The server's merge rule: higher version wins, a tie goes to the lower nonce. */
export function wins(incoming: El, stored: El | undefined): boolean {
  if (!stored) return true
  if (incoming.version !== stored.version) return incoming.version > stored.version
  return incoming.versionNonce < stored.versionNonce
}

export type RejectItem = [string | null, string, El | null]

/** GET /api/canvas/board: the server's scene, and whether this person may draw. */
export interface CanvasSnapshot { canvas: number; protocol: number; elements: El[]; checksum: number; editable: boolean; actors?: Record<string, string> }

export class Sync {
  private known = new Map<string, number>()
  private inflight = 0
  private uploaded: (fileId: string) => boolean

  /** `uploaded(fileId)`: an image goes out only once its bytes are on the server,
   *  so no peer ever sees an image element whose file 404s. */
  constructor(uploaded: (fileId: string) => boolean = () => true) {
    this.uploaded = uploaded
  }

  /** After a snapshot: the server holds exactly these. In-flight batches from a
   *  dead socket will never be acked, so they are forgotten (the diff covers them). */
  reset(server: readonly El[]) {
    this.known = new Map(server.map((e) => [e.id, e.version]))
    this.inflight = 0
  }

  /** Remote elements came in: the server holds at least these versions. */
  received(els: readonly El[]) {
    for (const e of els) if ((this.known.get(e.id) ?? -1) < e.version) this.known.set(e.id, e.version)
  }

  /** Batches to send now (each ≤ MAX_BATCH), marked as held by the server. */
  outgoing(scene: readonly El[]): El[][] {
    const out: El[] = []
    for (const e of scene) {
      if ((this.known.get(e.id) ?? -1) >= e.version) continue
      if (e.type === "image" && !e.isDeleted && e.fileId && !this.uploaded(e.fileId)) continue
      out.push(e)
      this.known.set(e.id, e.version)
    }
    const batches: El[][] = []
    for (let i = 0; i < out.length; i += MAX_BATCH) batches.push(out.slice(i, i + MAX_BATCH))
    this.inflight += batches.length
    return batches
  }

  /** The server answers every batch with one ack, in order. */
  acked() {
    if (this.inflight > 0) this.inflight--
  }

  /** Nothing sent is unanswered and nothing local is unsent — only then may a
   *  checksum mismatch mean real divergence. */
  settled(scene: readonly El[]): boolean {
    return this.inflight === 0 && scene.every((e) => (this.known.get(e.id) ?? -1) >= e.version)
  }

  /** Elements the scene must take from a reject. A stale loser adopts the
   *  server's winner unless we have edited past it since (then the diff resends);
   *  any other refusal is final: take the winner, or drop an element the server
   *  never had. Either way the adopted copy is marked held so it is not resent. */
  rejected(items: readonly RejectItem[], local: ReadonlyMap<string, El>): El[] {
    const adopt: El[] = []
    for (const [id, why, winner] of items) {
      if (!id) continue
      const mine = local.get(id)
      if (winner) {
        this.known.set(id, winner.version)
        if (why !== "stale" || !mine || wins(winner, mine)) adopt.push(winner)
      } else if (mine && !mine.isDeleted) {
        const gone = { ...mine, isDeleted: true }
        this.known.set(id, gone.version)
        adopt.push(gone)
      } else if (mine) {
        this.known.set(id, mine.version)
      }
    }
    return adopt
  }
}

/** Replace scene elements by id (a reject's winner must win even when its
 *  version is lower than ours, which a version-based reconcile would refuse). */
export function replaceById(scene: readonly El[], adopt: readonly El[]): El[] {
  const by = new Map(adopt.map((e) => [e.id, e]))
  return scene.map((e) => by.get(e.id) ?? e)
}

/** Image files the scene references but does not have yet (to GET from the server). */
export function missingFiles(scene: readonly El[], have: (fileId: string) => boolean): string[] {
  const want = new Set<string>()
  for (const e of scene) if (e.type === "image" && !e.isDeleted && e.fileId && !have(e.fileId)) want.add(e.fileId)
  return [...want]
}

const PALETTE = ["#e8590c", "#1971c2", "#2f9e44", "#9c36b5", "#c2255c", "#0c8599", "#f08c00", "#5f3dc4"]

/** A stable colour per peer, for cursors when the peer sent none. */
export function peerColor(peer: string): string {
  return PALETTE[fnv1a(peer) % PALETTE.length]
}

export interface PresenceMsg {
  t: "presence"
  peer: string
  pointer?: { x: number; y: number; tool?: string }
  button?: string
  selected?: Record<string, boolean>
  name?: string
  color?: string
}

/** One peer's presence as an Excalidraw collaborator. */
export function collaborator(m: PresenceMsg) {
  const c = typeof m.color === "string" && /^#[0-9a-f]{6}$/i.test(m.color) ? m.color : peerColor(m.peer)
  const p = m.pointer && Number.isFinite(m.pointer.x) && Number.isFinite(m.pointer.y) ? m.pointer : undefined
  return {
    id: m.peer,
    socketId: m.peer,
    username: typeof m.name === "string" ? m.name.slice(0, 40) : "",
    color: { background: c, stroke: c },
    button: m.button === "down" ? ("down" as const) : ("up" as const),
    selectedElementIds: m.selected && typeof m.selected === "object" ? m.selected : {},
    pointer: p ? { x: p.x, y: p.y, tool: p.tool === "laser" ? ("laser" as const) : ("pointer" as const) } : undefined,
  }
}
