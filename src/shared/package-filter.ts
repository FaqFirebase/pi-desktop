import type { CatalogPackage } from './ipc-contracts'

/** Lower-case whitespace-separated tokens of a search query; empty for a blank query. */
export function searchTokens(query: string | undefined): string[] {
  const trimmed = query?.trim().toLowerCase() ?? ''
  return trimmed ? trimmed.split(/\s+/) : []
}

/** True when the text contains every token (case-insensitive). */
export function matchesSearchTokens(text: string, tokens: readonly string[]): boolean {
  const haystack = text.toLowerCase()
  return tokens.every((token) => haystack.includes(token))
}

/**
 * Match every whitespace-separated token against the combined name, description
 * and author. Tokenizing lets multi-word queries like "ollama cloud" match a
 * package named "pi-ollama-cloud". Pure, so it runs the same in the main
 * process (initial crawl filter) and the renderer (live search filtering).
 */
export function filterCatalog(
  packages: CatalogPackage[],
  query: string | undefined
): CatalogPackage[] {
  const tokens = searchTokens(query)
  if (tokens.length === 0) return packages
  return packages.filter((pkg) =>
    matchesSearchTokens(`${pkg.name} ${pkg.description} ${pkg.author}`, tokens)
  )
}
