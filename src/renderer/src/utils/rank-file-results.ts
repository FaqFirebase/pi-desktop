import type { FileSearchResult } from '../../../shared/ipc-contracts'

// Rank file-search hits: exact basename match first, then basename prefix,
// then basename substring; ties broken by shorter path (closer to the
// workspace root), then alphabetically. The backend returns matches in
// filesystem-walk order, which otherwise buries good hits.
export function rankFileResults(results: FileSearchResult[], query: string): FileSearchResult[] {
  const q = query.toLowerCase()
  const score = (r: FileSearchResult): number => {
    const name = r.name.toLowerCase()
    if (name === q) return 0
    if (name.startsWith(q)) return 1
    if (name.includes(q)) return 2
    return 3
  }
  return [...results].sort((a, b) => {
    const byScore = score(a) - score(b)
    if (byScore !== 0) return byScore
    const byLen = a.relativePath.length - b.relativePath.length
    if (byLen !== 0) return byLen
    return a.relativePath.localeCompare(b.relativePath)
  })
}
