/**
 * Last-write-wins guard for overlapping async loads: each begin() supersedes
 * all earlier ones, and the returned check tells a load whether it is still
 * the latest — a stale load must drop its result instead of committing state
 * that would overwrite a newer response.
 */
export interface StaleGuard {
  /** Start a load; returns a check that is true while this load is the latest. */
  begin(): () => boolean
}

export function createStaleGuard(): StaleGuard {
  let seq = 0
  return {
    begin() {
      const id = ++seq
      return () => id === seq
    },
  }
}
