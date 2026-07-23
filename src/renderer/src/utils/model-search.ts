import type { ModelInfo } from '../../../shared/ipc-contracts'

/** Collapse case/punctuation so "sonnet 4" matches "claude-sonnet-4". */
export function normalizeModelSearchText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[_\-./:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Token AND match against name, id, and provider. Every whitespace-separated
 * query term must appear somewhere (as a substring) in the normalized haystack,
 * so partial names work without typing the exact model slug.
 */
export function filterModels(models: ModelInfo[], query: string): ModelInfo[] {
  const tokens = normalizeModelSearchText(query).split(' ').filter(Boolean)
  if (tokens.length === 0) return models
  return models.filter((m) => {
    const haystack = normalizeModelSearchText(`${m.name} ${m.id} ${m.provider}`)
    return tokens.every((t) => haystack.includes(t))
  })
}
