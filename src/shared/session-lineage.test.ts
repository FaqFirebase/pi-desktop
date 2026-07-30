import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildLineageTree, type SessionLineageRecord } from './session-lineage'

const recs: SessionLineageRecord[] = [
  { sessionId: 'root', path: '/s/root.jsonl', name: 'Root', preview: null, parentPath: null },
  { sessionId: 'childA', path: '/s/a.jsonl', name: 'A', preview: null, parentPath: '/s/root.jsonl' },
  { sessionId: 'childB', path: '/s/b.jsonl', name: 'B', preview: null, parentPath: '/s/root.jsonl' },
  { sessionId: 'grand', path: '/s/g.jsonl', name: 'G', preview: null, parentPath: '/s/a.jsonl' },
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
    { sessionId: 'x', path: '/s/x.jsonl', name: 'X', preview: null, parentPath: '/s/missing.jsonl' },
  ]
  const roots = buildLineageTree(orphan)
  assert.equal(roots.length, 1)
  assert.equal(roots[0].sessionId, 'x')
})

test('does not infinite-loop on a self-referential cycle', () => {
  const cyclic: SessionLineageRecord[] = [
    { sessionId: 'c', path: '/s/c.jsonl', name: 'C', preview: null, parentPath: '/s/c.jsonl' },
  ]
  const roots = buildLineageTree(cyclic)
  assert.equal(roots.length, 1)
  assert.equal(roots[0].sessionId, 'c')
})

test('carries the message preview through the tree build', () => {
  const withPreview: SessionLineageRecord[] = [
    { sessionId: 'p', path: '/s/p.jsonl', name: null, preview: 'Refactor auth', parentPath: null },
    {
      sessionId: 'c',
      path: '/s/c.jsonl',
      name: null,
      preview: 'Fix token refresh',
      parentPath: '/s/p.jsonl',
    },
  ]
  const roots = buildLineageTree(withPreview)
  assert.equal(roots[0].preview, 'Refactor auth')
  assert.equal(roots[0].children[0].preview, 'Fix token refresh')
})

test('links a child whose parentPath differs only in case on win32', () => {
  // getSessionsRoot() reads HOME/USERPROFILE while Pi resolves parentSession via
  // os.homedir(); neither canonicalizes drive-letter case, so a raw map lookup
  // misses and the child silently becomes a second root.
  const winRecs: SessionLineageRecord[] = [
    {
      sessionId: 'parent',
      path: 'C:\\Users\\night\\.pi\\agent\\sessions\\proj\\parent.jsonl',
      name: null,
      preview: 'parent topic',
      parentPath: null,
    },
    {
      sessionId: 'child',
      path: 'C:\\Users\\night\\.pi\\agent\\sessions\\proj\\child.jsonl',
      name: null,
      preview: 'child topic',
      parentPath: 'c:\\users\\night\\.pi\\agent\\sessions\\proj\\parent.jsonl',
    },
  ]
  const roots = buildLineageTree(winRecs, true)
  assert.equal(roots.length, 1)
  assert.equal(roots[0].sessionId, 'parent')
  assert.equal(roots[0].children.length, 1)
  assert.equal(roots[0].children[0].sessionId, 'child')
})

test('keeps case-distinct POSIX paths separate', () => {
  // The same fold must not apply on POSIX, where the two really are different.
  const posixRecs: SessionLineageRecord[] = [
    { sessionId: 'lower', path: '/s/a.jsonl', name: null, preview: 'lower', parentPath: null },
    { sessionId: 'upper', path: '/s/A.jsonl', name: null, preview: 'upper', parentPath: '/s/a.jsonl' },
  ]
  const roots = buildLineageTree(posixRecs, false)
  assert.equal(roots.length, 1)
  assert.equal(roots[0].children.length, 1)

  // …and a parent reference that only matches under folding stays an orphan.
  const unmatched: SessionLineageRecord[] = [
    { sessionId: 'lower', path: '/s/a.jsonl', name: null, preview: 'lower', parentPath: null },
    { sessionId: 'other', path: '/s/b.jsonl', name: null, preview: 'other', parentPath: '/s/A.jsonl' },
  ]
  assert.equal(buildLineageTree(unmatched, false).length, 2)
})
