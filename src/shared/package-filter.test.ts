import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CatalogPackage } from './ipc-contracts'
import { filterCatalog, matchesSearchTokens, searchTokens } from './package-filter'

test('searchTokens lower-cases and splits on whitespace; a blank query has none', () => {
  assert.deepEqual(searchTokens('  Ollama   CLOUD '), ['ollama', 'cloud'])
  assert.deepEqual(searchTokens('   '), [])
  assert.deepEqual(searchTokens(undefined), [])
})

test('matchesSearchTokens needs every token, in any case', () => {
  assert.equal(matchesSearchTokens('pi-Ollama-Cloud', ['ollama', 'cloud']), true)
  assert.equal(matchesSearchTokens('pi-ollama', ['ollama', 'cloud']), false)
  assert.equal(matchesSearchTokens('anything', []), true)
})

test('filterCatalog matches name, description, and author', () => {
  const packages = [
    { name: 'pi-ollama-cloud', description: 'Cloud models', author: 'a' },
    { name: 'pi-voice', description: 'Speech', author: 'ollama fan' },
    { name: 'pi-other', description: 'Other', author: 'b' },
  ] as CatalogPackage[]
  assert.deepEqual(filterCatalog(packages, 'ollama').map((p) => p.name), ['pi-ollama-cloud', 'pi-voice'])
  assert.equal(filterCatalog(packages, '  ').length, packages.length)
})
