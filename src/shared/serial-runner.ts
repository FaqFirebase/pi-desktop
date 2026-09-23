export type SerialRunner = <T>(task: () => Promise<T>) => Promise<T>

/**
 * Runs async tasks one at a time, in call order. A task that fails rejects
 * only its own caller; later tasks still run.
 */
export function createSerialRunner(): SerialRunner {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task)
    tail = run.catch(() => undefined)
    return run
  }
}
