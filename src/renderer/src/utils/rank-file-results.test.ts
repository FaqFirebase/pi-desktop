import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rankFileResults } from './rank-file-results'
import type { FileSearchResult } from '../../../shared/ipc-contracts'

function result(name: string, relativePath: string): FileSearchResult {
  return { path: `/ws/${relativePath}`, relativePath, name, matchType: 'filename' }
}

test('exact basename beats prefix beats substring beats other', () => {
  const ranked = rankFileResults(
    [
      result('main-store.ts', 'src/main-store.ts'),
      result('store', 'src/store'),
      result('store.ts', 'src/store.ts'),
      result('index.ts', 'src/index.ts'),
    ],
    'store',
  )
  assert.deepEqual(
    ranked.map((r) => r.name),
    ['store', 'store.ts', 'main-store.ts', 'index.ts'],
  )
})

test('ties break by shorter path then alphabetically', () => {
  const ranked = rankFileResults(
    [
      result('a.ts', 'deep/nested/dir/a.ts'),
      result('a.ts', 'src/a.ts'),
      result('a.ts', 'lib/a.ts'),
    ],
    'a.ts',
  )
  assert.deepEqual(
    ranked.map((r) => r.relativePath),
    ['lib/a.ts', 'src/a.ts', 'deep/nested/dir/a.ts'],
  )
})

test('does not mutate the input array', () => {
  const input = [result('b.ts', 'b.ts'), result('a.ts', 'a.ts')]
  const snapshot = [...input]
  rankFileResults(input, 'a.ts')
  assert.deepEqual(input, snapshot)
})
