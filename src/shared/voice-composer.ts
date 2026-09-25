// Live dictation writes a running transcript into the composer and rewrites it
// as more speech arrives. The interim text occupies a region that starts at
// `anchor` and is `prevLength` characters long; replacing it leaves everything
// the user typed before the anchor and after the region untouched.

export interface InterimResult {
  /** New full composer value. */
  value: string
  /** Length of the interim region now, for the next replacement. */
  interimLength: number
  /** Where the caret should sit (just after the interim region). */
  caret: number
}

export function applyInterim(
  value: string,
  anchor: number,
  prevLength: number,
  text: string,
): InterimResult {
  const before = value.slice(0, anchor)
  const after = value.slice(anchor + prevLength)
  return {
    value: before + text + after,
    interimLength: text.length,
    caret: anchor + text.length,
  }
}
