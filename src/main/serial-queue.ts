/** Runs a task after every task queued before it has settled. */
export type SerialQueue = <T>(task: () => Promise<T>) => Promise<T>

/**
 * A queue that runs its tasks one at a time, in call order. A file that is
 * read, changed and written back uses one, so a fast second write starts from
 * the result of the first instead of racing it. A failed task rejects only its
 * own caller; the tasks after it still run.
 */
export function createSerialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task)
    tail = run.catch(() => undefined)
    return run
  }
}
