export type HistoryPage = { lines: string[]; start: number; size: number }

/** Growing tail window. All readers share a flight; paging commits only on success. */
export function createHistoryPager(read: (tail: number) => Promise<HistoryPage>, step = 400) {
  let window = step
  let hasMore = false
  let flight: Promise<HistoryPage> | null = null
  function fetch(tail: number): Promise<HistoryPage> {
    const request = Promise.resolve().then(() => read(tail)).then((page) => {
      window = tail
      hasMore = page.start > 0
      return page
    }).finally(() => { flight = null })
    flight = request
    return request
  }
  return {
    load: (fresh = false): Promise<HistoryPage> => {
      // Completion must read after any older in-flight page, not mistake that
      // page for the final reply and stop polling before the reply is visible.
      if (fresh && flight) return flight.catch(() => {}).then(() => flight || fetch(window))
      return flight || fetch(window)
    },
    more: (): Promise<HistoryPage | undefined> => {
      if (flight || !hasMore) return Promise.resolve(undefined)
      return fetch(window + step)
    },
  }
}
