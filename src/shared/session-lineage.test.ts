import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildLineageTree, type SessionLineageRecord } from './session-lineage'

const recs: SessionLineageRecord[] = [
  { sessionId: 'root', path: '/s/root.jsonl', name: 'Root', parentPath: null },
  { sessionId: 'childA', path: '/s/a.jsonl', name: 'A', parentPath: '/s/root.jsonl' },
  { sessionId: 'childB', path: '/s/b.jsonl', name: 'B', parentPath: '/s/root.jsonl' },
  { sessionId: 'grand', path: '/s/g.jsonl', name: 'G', parentPath: '/s/a.jsonl' },
]

test('builds a tree rooted at parentless sessions', () => {
  const roots = buildLineageTree(recs)
  assert.equal(roots.length, 1)
  assert.equal(roots[0].sessionId, 'root')
  assert.equal(roots[0].children.length, 2)
})

test('nests grandchildren under the correct parent', () => {
  const roots = buildLineageTree(recs)
  const a = roots[0].children.find((c) => c.sessionId === 'childA')!
  assert.equal(a.children.length, 1)
  assert.equal(a.children[0].sessionId, 'grand')
})

test('treats a parentPath with no matching session as a root', () => {
  const orphan: SessionLineageRecord[] = [
    { sessionId: 'x', path: '/s/x.jsonl', name: 'X', parentPath: '/s/missing.jsonl' },
  ]
  const roots = buildLineageTree(orphan)
  assert.equal(roots.length, 1)
  assert.equal(roots[0].sessionId, 'x')
})

test('does not infinite-loop on a self-referential cycle', () => {
  const cyclic: SessionLineageRecord[] = [
    { sessionId: 'c', path: '/s/c.jsonl', name: 'C', parentPath: '/s/c.jsonl' },
  ]
  const roots = buildLineageTree(cyclic)
  assert.equal(roots.length, 1)
  assert.equal(roots[0].sessionId, 'c')
})
