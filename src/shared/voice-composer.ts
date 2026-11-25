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

// dictated words keep a space from a word they would touch, but not from an opening bracket or quote
const NEEDS_SPACE_AFTER = /[^\s([{"'“‘«]$/u
const NEEDS_SPACE_BEFORE = /^[\p{L}\p{N}]/u
const SPACE = ' '

export function applyInterim(
  value: string,
  anchor: number,
  prevLength: number,
  text: string,
): InterimResult {
  const before = value.slice(0, anchor)
  const after = value.slice(anchor + prevLength)
  // the spaces belong to the interim region, so the next rewrite replaces them too
  const lead = text && NEEDS_SPACE_AFTER.test(before) ? SPACE : ''
  const trail = text && NEEDS_SPACE_BEFORE.test(after) ? SPACE : ''
  const inserted = lead + text + trail
  return {
    value: before + inserted + after,
    interimLength: inserted.length,
    caret: anchor + lead.length + text.length,
  }
}
