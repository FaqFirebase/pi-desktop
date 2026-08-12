import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  droppedFolderCandidates,
  isFileDrag,
  workspaceNameFromFolderPath,
  type FileDragItem,
  type FileDragTransfer,
} from './folder-drop'

test('workspaceNameFromFolderPath uses the last path segment', () => {
  assert.equal(workspaceNameFromFolderPath('/home/alice/my-app'), 'my-app')
  assert.equal(workspaceNameFromFolderPath('C:\\Users\\bob\\proj'), 'proj')
  assert.equal(workspaceNameFromFolderPath('/home/alice/my-app/'), 'my-app')
})

test('workspaceNameFromFolderPath falls back when empty-ish', () => {
  assert.equal(workspaceNameFromFolderPath('/'), '/')
  assert.equal(workspaceNameFromFolderPath(''), '')
})

test('isFileDrag detects the Files type (Chromium array)', () => {
  assert.equal(isFileDrag({ types: ['Files'] }), true)
  assert.equal(isFileDrag({ types: ['text/plain'] }), false)
  assert.equal(isFileDrag(null), false)
})

function transferOf(items: FileDragItem[]): FileDragTransfer {
  const indexed: Record<number, FileDragItem> & { length: number } = { length: items.length }
  items.forEach((item, i) => {
    indexed[i] = item
  })
  return { types: ['Files'], items: indexed }
}

test('droppedFolderCandidates keeps directory entries and drops plain files', () => {
  const dirFile = { name: 'proj' } as File
  const plainFile = { name: 'readme.md' } as File
  const dt = transferOf([
    {
      kind: 'file',
      webkitGetAsEntry: () => ({ isDirectory: false, isFile: true }),
      getAsFile: () => plainFile,
    },
    {
      kind: 'file',
      webkitGetAsEntry: () => ({ isDirectory: true, isFile: false }),
      getAsFile: () => dirFile,
    },
  ])

  const paths = new Map<File, string>([
    [dirFile, '/tmp/proj'],
    [plainFile, '/tmp/readme.md'],
  ])
  assert.deepEqual(
    droppedFolderCandidates(dt, (f) => paths.get(f) ?? ''),
    ['/tmp/proj']
  )
})

test('droppedFolderCandidates keeps entry-less items as unknowns', () => {
  const f = { name: 'maybe-dir' } as File
  const dt = transferOf([
    {
      kind: 'file',
      webkitGetAsEntry: () => null,
      getAsFile: () => f,
    },
  ])

  assert.deepEqual(droppedFolderCandidates(dt, () => '/tmp/maybe-dir'), ['/tmp/maybe-dir'])
})

test('droppedFolderCandidates orders confirmed directories before unknowns', () => {
  // An entry-less item first in the drop must not shadow a confirmed folder
  // after it — the caller probes in the returned order.
  const mysteryFile = { name: 'mystery' } as File
  const dirFile = { name: 'proj' } as File
  const dt = transferOf([
    {
      kind: 'file',
      webkitGetAsEntry: () => null,
      getAsFile: () => mysteryFile,
    },
    {
      kind: 'file',
      webkitGetAsEntry: () => ({ isDirectory: true, isFile: false }),
      getAsFile: () => dirFile,
    },
  ])

  const paths = new Map<File, string>([
    [mysteryFile, '/tmp/mystery'],
    [dirFile, '/tmp/proj'],
  ])
  assert.deepEqual(
    droppedFolderCandidates(dt, (f) => paths.get(f) ?? ''),
    ['/tmp/proj', '/tmp/mystery']
  )
})

test('droppedFolderCandidates is empty when only classified files are present', () => {
  const plainFile = { name: 'readme.md' } as File
  const dt = transferOf([
    {
      kind: 'file',
      webkitGetAsEntry: () => ({ isDirectory: false, isFile: true }),
      getAsFile: () => plainFile,
    },
  ])

  assert.deepEqual(droppedFolderCandidates(dt, () => '/tmp/readme.md'), [])
})

test('droppedFolderCandidates is empty for an itemless transfer', () => {
  assert.deepEqual(droppedFolderCandidates({ types: ['Files'], items: null }, () => ''), [])
})
