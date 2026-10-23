/**
 * Token counts for one model. Pi and OMP both record these four categories as
 * disjoint numbers (`totalTokens` in a usage record equals their sum), so the
 * total adds them without counting a cached token twice.
 */
export interface TokenUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export function emptyTokenUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

/** Add `source` into `target` in place. */
export function addTokenUsage(target: TokenUsage, source: TokenUsage): void {
  target.input += source.input
  target.output += source.output
  target.cacheRead += source.cacheRead
  target.cacheWrite += source.cacheWrite
}

export function totalTokenUsage(usage: TokenUsage): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite
}

export function cacheTokenUsage(usage: TokenUsage): number {
  return usage.cacheRead + usage.cacheWrite
}
