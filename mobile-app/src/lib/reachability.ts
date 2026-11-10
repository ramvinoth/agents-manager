/**
 * Whether the app can reach its server right now — one signal the whole app
 * shares. api/client.ts#req reports every request's outcome here: any HTTP
 * reply (even a 500) proves the server answered; a transport failure (no
 * status) means the phone is offline or the server/relay is down. There is no
 * separate probe: the screens' own polls retry, and the first success flips
 * the app back online.
 *
 * Pure (time injected), so the transition rules are node-tested.
 */
export type ReachState = { online: boolean; since: number }

export class Reachability {
  private state: ReachState = { online: true, since: 0 }
  private listeners = new Set<(s: ReachState) => void>()

  get(): ReachState {
    return this.state
  }

  /** Record one request's outcome; listeners hear only real transitions. */
  /** First transport failure of the current streak (null = last call succeeded). */
  private failingSince: number | null = null

  /** One failure is not an outage: iOS aborts in-flight fetches when the app is
   *  suspended, and a single network blip flashed the banner. Go offline only on a
   *  second failure with no success in between; `since` is the first failure. */
  report(reached: boolean, now = Date.now()): void {
    if (reached) {
      this.failingSince = null
      if (!this.state.online) this.set({ online: true, since: now })
      return
    }
    if (this.failingSince === null) {
      this.failingSince = now
      return
    }
    if (this.state.online) this.set({ online: false, since: this.failingSince })
  }

  private set(next: ReachState): void {
    this.state = next
    this.listeners.forEach((fn) => fn(this.state))
  }

  subscribe(fn: (s: ReachState) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
}

/** The app-wide instance. */
export const reachability = new Reachability()
