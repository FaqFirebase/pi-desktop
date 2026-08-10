import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  firstDroppedFolderPath,
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

test('isFileDrag detects the Files type (Chromium array)', () => {
  assert.equal(isFileDrag({ types: ['Files'] }), true)
  assert.equal(isFileDrag({ types: ['text/plain'] }), false)
  assert.equal(isFileDrag(null), false)
})

test('firstDroppedFolderPath returns the first directory entry path', () => {
  const dirFile = { name: 'proj' } as File
  const plainFile = { name: 'readme.md' } as File
  const items = [
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
  ]
  const dt: FileDragTransfer = {
    types: ['Files'],
    items: {
      length: items.length,
      0: items[0],
      1: items[1],
    },
  }

  const paths = new Map<File, string>([
    [dirFile, '/tmp/proj'],
    [plainFile, '/tmp/readme.md'],
  ])
  assert.equal(
    firstDroppedFolderPath(dt, (f) => paths.get(f) ?? ''),
    '/tmp/proj'
  )
})

test('firstDroppedFolderPath uses getAsFile when webkitGetAsEntry is null', () => {
  const f = { name: 'maybe-dir' } as File
  const dt: FileDragTransfer = {
    types: ['Files'],
    items: {
      length: 1,
      0: {
        kind: 'file',
        webkitGetAsEntry: () => null,
        getAsFile: () => f,
      },
    },
  }
  assert.equal(firstDroppedFolderPath(dt, () => '/tmp/maybe-dir'), '/tmp/maybe-dir')
})

test('firstDroppedFolderPath returns null when only files are present', () => {
  const plainFile = { name: 'readme.md' } as File
  const dt: FileDragTransfer = {
    types: ['Files'],
    items: {
      length: 1,
      0: {
        kind: 'file',
        webkitGetAsEntry: () => ({ isDirectory: false, isFile: true }),
        getAsFile: () => plainFile,
      },
    },
  }
  assert.equal(firstDroppedFolderPath(dt, () => '/tmp/readme.md'), null)
})
