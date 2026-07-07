import assert from 'node:assert/strict'
import { test, afterEach } from 'node:test'
import {
  parseCatalogHtml,
  filterCatalog,
  fetchAllCatalogPackages,
  fetchPackageCatalog,
  clearCatalogCache,
  PAGE_CONCURRENCY,
} from './package-catalog'

// ─── Fixtures ────────────────────────────────────────────────────────────────

function card(opts: {
  name: string
  desc?: string
  author?: string
  type?: string
  downloads?: number
}): string {
  const { name, desc = '', author = 'someone', type = 'extension', downloads = 100 } = opts
  return `<article data-package-card="true" data-package-name="${name}" data-package-downloads="${downloads}" data-package-date="1700000000000" data-type="${type}">
  <p class="packages-desc">${desc}</p>
  <div class="packages-meta"><span>${author}</span><span>${downloads}/mo</span><span>2 days ago</span></div>
  <a href="https://www.npmjs.com/package/${name}">npm</a>
  <a href="https://github.com/${author}/${name}/issues/1">issue</a>
  <a href="https://github.com/${author}/${name}">repo</a>
</article>`
}

function page(cards: string[]): string {
  return `<html><body>${cards.join('\n')}</body></html>`
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  clearCatalogCache()
})

// ─── parseCatalogHtml ────────────────────────────────────────────────────────

test('parseCatalogHtml extracts package fields from a card', () => {
  const html = page([
    card({ name: 'pi-ollama-cloud', desc: 'Cloud vision provider', author: 'alice', downloads: 1234 }),
  ])
  const [pkg] = parseCatalogHtml(html)

  assert.equal(pkg.name, 'pi-ollama-cloud')
  assert.equal(pkg.description, 'Cloud vision provider')
  assert.equal(pkg.author, 'alice')
  assert.equal(pkg.type, 'extension')
  assert.equal(pkg.downloads, 1234)
  assert.equal(pkg.downloadsDisplay, '1234/mo')
  assert.equal(pkg.npmUrl, 'https://www.npmjs.com/package/pi-ollama-cloud')
  assert.equal(pkg.installCommand, 'npm:pi-ollama-cloud')
})

test('parseCatalogHtml prefers the repo link over the issues link', () => {
  const [pkg] = parseCatalogHtml(page([card({ name: 'pkg', author: 'bob' })]))
  // The /issues/ URL appears first in the fixture; it must be skipped.
  assert.equal(pkg.repoUrl, 'https://github.com/bob/pkg')
})

test('parseCatalogHtml returns [] when there are no cards', () => {
  assert.deepEqual(parseCatalogHtml('<html><body>nothing here</body></html>'), [])
})

// ─── filterCatalog ───────────────────────────────────────────────────────────

const SAMPLE = parseCatalogHtml(
  page([
    card({ name: 'pi-ollama-cloud', desc: 'Cloud vision provider', author: 'alice' }),
    card({ name: '@ollama/pi-web-search', desc: 'Web search', author: 'ollama' }),
    card({ name: 'pi-intercom', desc: 'Intercom integration', author: 'carol' }),
  ])
)

test('filterCatalog returns all packages for an empty query', () => {
  assert.equal(filterCatalog(SAMPLE, undefined).length, 3)
  assert.equal(filterCatalog(SAMPLE, '   ').length, 3)
})

test('filterCatalog matches a single token in the name', () => {
  const result = filterCatalog(SAMPLE, 'intercom')
  assert.deepEqual(result.map((p) => p.name), ['pi-intercom'])
})

test('filterCatalog matches multi-word queries across hyphenated names', () => {
  // "ollama cloud" must match "pi-ollama-cloud" even though the literal
  // substring "ollama cloud" never appears.
  const result = filterCatalog(SAMPLE, 'ollama cloud')
  assert.deepEqual(result.map((p) => p.name), ['pi-ollama-cloud'])
})

test('filterCatalog is case-insensitive and matches author/description', () => {
  assert.equal(filterCatalog(SAMPLE, 'OLLAMA').length, 2)
  assert.deepEqual(filterCatalog(SAMPLE, 'web search').map((p) => p.name), ['@ollama/pi-web-search'])
})

test('filterCatalog returns [] when no package matches', () => {
  assert.deepEqual(filterCatalog(SAMPLE, 'nonexistent-xyz'), [])
})

// ─── fetchAllCatalogPackages (pagination + cache) ─────────────────────────────

const FULL_PAGE = page(Array.from({ length: 50 }, (_, i) => card({ name: `pkg-${i}` })))
// Distinct names per page so a realistic catalog (unique package names) isn't
// collapsed by the crawler's name-dedup.
const fullPageOf = (base: number): string =>
  page(Array.from({ length: 50 }, (_, i) => card({ name: `pkg-${base}-${i}` })))
const SHORT_PAGE = page([card({ name: 'pi-ollama-cloud' }), card({ name: 'last-one' })])

function stubPages(pages: Record<number, string>): () => number {
  let calls = 0
  globalThis.fetch = (async (url: string | URL) => {
    calls += 1
    const pageNum = Number(new URL(String(url)).searchParams.get('page'))
    const body = pages[pageNum] ?? page([])
    return { ok: true, text: async () => body } as Response
  }) as typeof fetch
  return () => calls
}

test('fetchAllCatalogPackages crawls in batches and stops after the short page', async () => {
  const calls = stubPages({ 1: fullPageOf(1), 2: fullPageOf(2), 3: SHORT_PAGE })
  const packages = await fetchAllCatalogPackages({ force: true })

  // 50 + 50 + 2 unique cards collected. Pages past 3 are fetched concurrently in
  // the same batch but return empty, and the short page 3 stops further batches.
  assert.equal(packages.length, 102)
  assert.ok(calls() >= 3 && calls() <= PAGE_CONCURRENCY, 'stops after the first concurrent batch')
  assert.ok(packages.some((p) => p.name === 'pi-ollama-cloud'))
})

test('fetchAllCatalogPackages serves a cached result without refetching', async () => {
  const calls = stubPages({ 1: SHORT_PAGE })
  await fetchAllCatalogPackages({ force: true })
  const callsAfterFirst = calls()

  await fetchAllCatalogPackages()
  assert.equal(calls(), callsAfterFirst, 'second call must hit the cache')
})

test('fetchPackageCatalog finds a package that lives beyond the first page', async () => {
  stubPages({ 1: FULL_PAGE, 2: SHORT_PAGE })
  const result = await fetchPackageCatalog('ollama cloud')
  assert.deepEqual(result.map((p) => p.name), ['pi-ollama-cloud'])
})

test('fetchPackageCatalog returns [] when the network throws', async () => {
  globalThis.fetch = (async () => {
    throw new Error('network down')
  }) as typeof fetch
  assert.deepEqual(await fetchPackageCatalog('anything'), [])
})
