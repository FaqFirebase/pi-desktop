import type { ModelInfo } from '../../../shared/ipc-contracts'
import { modelRecencyKey, type ModelRecency } from './model-recency'

/** Lowercase and treat `_` / `-` / `.` as spaces so "sonnet 4" hits "claude-sonnet-4". */
export function normalizeModelSearchText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[_\-./:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Most recently used first; never-used models keep their original order after them. */
export function sortModelsByRecency(models: ModelInfo[], recency: ModelRecency): ModelInfo[] {
  const lastUsed = (m: ModelInfo): number => recency[modelRecencyKey(m)] ?? -Infinity
  return models
    .map((m, index) => ({ m, index, used: lastUsed(m) }))
    .sort((a, b) => (b.used === a.used ? a.index - b.index : b.used - a.used))
    .map(({ m }) => m)
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
