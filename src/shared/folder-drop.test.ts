import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  collectDroppedPaths,
  isFileDrag,
  workspaceNameFromFolderPath,
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

test('isFileDrag detects Files type', () => {
  assert.equal(isFileDrag({ types: ['Files'], files: { length: 0 } }), true)
  assert.equal(isFileDrag({ types: ['text/plain'], files: { length: 0 } }), false)
  assert.equal(isFileDrag(null), false)
})

test('collectDroppedPaths keeps directory entries only when entry API exists', () => {
  const dirFile = { name: 'proj' } as File
  const plainFile = { name: 'readme.md' } as File
  const items = [
    {
      kind: 'file',
      webkitGetAsEntry: () => ({ isDirectory: true, isFile: false }),
      getAsFile: () => dirFile,
    },
    {
      kind: 'file',
      webkitGetAsEntry: () => ({ isDirectory: false, isFile: true }),
      getAsFile: () => plainFile,
    },
  ]
  const dt: FileDragTransfer = {
    types: ['Files'],
    items: {
      length: items.length,
      0: items[0],
      1: items[1],
    },
    files: { length: 0 },
  }

  const paths = new Map<File, string>([
    [dirFile, '/tmp/proj'],
    [plainFile, '/tmp/readme.md'],
  ])
  const result = collectDroppedPaths(dt, (f) => paths.get(f) ?? '')
  assert.deepEqual(result.paths, ['/tmp/proj'])
  assert.equal(result.hadNonDirectoryEntry, true)
})

test('collectDroppedPaths falls back to files when entry API is missing', () => {
  const f = { name: 'maybe-dir' } as File
  const dt: FileDragTransfer = {
    types: ['Files'],
    items: null,
    files: {
      length: 1,
      0: f,
    },
  }
  const result = collectDroppedPaths(dt, () => '/tmp/maybe-dir')
  assert.deepEqual(result.paths, ['/tmp/maybe-dir'])
})
