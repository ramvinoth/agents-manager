/**
 * Share one request between a prefetch and the screen that wants the result.
 * A finger touching a chat row starts the read; the thread screen mounting a
 * moment later gets the same promise instead of a second request. A result
 * stays shareable for `freshMs` after it settles, then the next get reloads.
 * A failed load is never shared: the next get retries.
 */
export class Prefetcher<T> {
  private entries = new Map<string, { value: Promise<T>; settled: number | null }>()
  private freshMs: number
  private now: () => number

  constructor(freshMs = 3000, now: () => number = Date.now) {
    this.freshMs = freshMs
    this.now = now
  }

  get(key: string, load: () => Promise<T>): Promise<T> {
    this.prune()
    const hit = this.entries.get(key)
    if (hit) return hit.value
    const entry: { value: Promise<T>; settled: number | null } = { value: load(), settled: null }
    this.entries.set(key, entry)
    entry.value.then(
      () => void (entry.settled = this.now()),
      () => void (this.entries.get(key) === entry && this.entries.delete(key))
    )
    return entry.value
  }

  private prune() {
    const t = this.now()
    for (const [k, e] of this.entries) if (e.settled !== null && t - e.settled >= this.freshMs) this.entries.delete(k)
  }
}
