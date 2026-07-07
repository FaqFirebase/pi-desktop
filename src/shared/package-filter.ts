import type { CatalogPackage } from './ipc-contracts'

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
  if (!query || !query.trim()) return packages
  const tokens = query.trim().toLowerCase().split(/\s+/)
  return packages.filter((pkg) => {
    const haystack = `${pkg.name} ${pkg.description} ${pkg.author}`.toLowerCase()
    return tokens.every((token) => haystack.includes(token))
  })
}
