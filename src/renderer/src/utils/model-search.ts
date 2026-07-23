import type { ModelInfo } from '../../../shared/ipc-contracts'

/** Lowercase and treat `_` / `-` / `.` as spaces so "sonnet 4" hits "claude-sonnet-4". */
export function normalizeModelSearchText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[_\-./:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Every query token must match somewhere in name, id, or provider. */
export function filterModels(models: ModelInfo[], query: string): ModelInfo[] {
  const tokens = normalizeModelSearchText(query).split(' ').filter(Boolean)
  if (tokens.length === 0) return models
  return models.filter((m) => {
    const haystack = normalizeModelSearchText(`${m.name} ${m.id} ${m.provider}`)
    return tokens.every((t) => haystack.includes(t))
  })
}
