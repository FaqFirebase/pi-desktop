/** Place a stamped delta, ignoring bytes already covered by a snapshot.
 * A gap returns null so the caller can recover the missing prefix. */
export function placeStreamedDelta(current: string, delta: string, offset: number | undefined): string | null {
  if (offset === undefined) return current + delta
  if (offset > current.length) return null
  return offset + delta.length <= current.length ? current : current.slice(0, offset) + delta
}
