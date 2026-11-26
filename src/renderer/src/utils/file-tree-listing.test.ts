import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FileTreeNode } from '../../../shared/ipc-contracts'
import { isFolderExpanded, loadOpenFolders } from './file-tree-listing'

function folder(relativePath: string): FileTreeNode {
  const name = relativePath.split('/').pop()!
  return { name, path: `/w/${relativePath}`, relativePath, type: 'directory' }
}

function file(relativePath: string): FileTreeNode {
  return { ...folder(relativePath), type: 'file' }
}

const TREE: Record<string, FileTreeNode[]> = {
  '': [folder('src'), folder('docs'), file('README.md')],
  src: [folder('src/lib'), file('src/a.ts')],
  'src/lib': [file('src/lib/b.ts')],
  docs: [],
}

test('top-level folders start open, deeper ones closed, and a toggle flips the default', () => {
  const none = new Set<string>()
  assert.equal(isFolderExpanded('src', none), true)
  assert.equal(isFolderExpanded('src/lib', none), false)
  const toggled = new Set(['src', 'src/lib'])
  assert.equal(isFolderExpanded('src', toggled), false)
  assert.equal(isFolderExpanded('src/lib', toggled), true)
})

test('only the root and open folders are listed, each once', async () => {
  const listed: string[] = []
  const listDir = async (dir: string): Promise<FileTreeNode[]> => {
    listed.push(dir)
    return TREE[dir]
  }

  const closed = await loadOpenFolders(listDir, (dir) => isFolderExpanded(dir, new Set()))
  assert.deepEqual([...closed.keys()].sort(), ['', 'docs', 'src'])
  assert.deepEqual(listed.sort(), ['', 'docs', 'src'])

  // An open folder inside a closed one is not reached.
  const hidden = await loadOpenFolders(listDir, (dir) => isFolderExpanded(dir, new Set(['src', 'src/lib'])))
  assert.deepEqual([...hidden.keys()].sort(), ['', 'docs'])

  const deep = await loadOpenFolders(listDir, (dir) => isFolderExpanded(dir, new Set(['src/lib'])))
  assert.deepEqual(deep.get('src/lib'), TREE['src/lib'])
})

test('a folder that cannot be listed shows empty; a root failure throws', async () => {
  const listings = await loadOpenFolders(
    async (dir) => {
      if (dir === 'src') throw Object.assign(new Error('denied'), { code: 'EACCES' })
      return TREE[dir]
    },
    (dir) => isFolderExpanded(dir, new Set())
  )
  assert.deepEqual(listings.get('src'), [])
  assert.deepEqual(listings.get(''), TREE[''])

  await assert.rejects(
    loadOpenFolders(async () => {
      throw new Error('missing')
    }, () => true),
    /missing/
  )
})
