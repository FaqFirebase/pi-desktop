/**
 * Run `task` one at a time. A call while it runs queues one more run, which
 * starts when the current one settles; further calls in the meantime share
 * that queued run. Each call's promise settles with the run that covers it,
 * so a caller never sees a result older than its own call.
 */
export function createSingleFlight(task: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null
  let queued: Promise<void> | null = null

  const start = (): Promise<void> => {
    const run = task().finally(() => {
      running = null
    })
    running = run
    return run
  }

  return () => {
    if (!running) return start()
    queued ??= running
      .catch(() => {})
      .then(() => {
        queued = null
        return start()
      })
    return queued
  }
}
