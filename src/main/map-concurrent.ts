/**
 * Run `mapper` over `items` with at most `limit` calls in flight, keeping results
 * positional. Shared by the session-list and lineage readers, which both fan out
 * bounded file reads across every session in the store and would otherwise each
 * carry their own worker pool.
 *
 * Rejects on the first mapper rejection, like `Promise.all`.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  if (items.length === 0) return results

  // A non-positive limit would leave no worker to drain the queue.
  const workerCount = Math.min(Math.max(1, Math.floor(limit)), items.length)
  let cursor = 0

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await mapper(items[index], index)
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}
