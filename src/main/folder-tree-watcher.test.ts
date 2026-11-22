import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { watchFolderTree, type FolderTreeWatch } from './folder-tree-watcher'
import { makeTempDir } from '../shared/temp-dir.test-helper'

/** Longest wait for one operating-system file event. */
const EVENT_TIMEOUT_MS = 3000
/** Wait used to show that an event does not come. */
const QUIET_WINDOW_MS = 600
const DEFAULT_MAX_DEPTH = 5
const IGNORED_FOLDER_NAME = 'node_modules'

interface Recorder {
  paths: string[]
  errors: unknown[]
  /** Resolves when `path` is reported, rejects after `EVENT_TIMEOUT_MS`. */
  reported(path: string): Promise<void>
}

function startRecording(root: string, maxDepth = DEFAULT_MAX_DEPTH): { watch: FolderTreeWatch; recorder: Recorder } {
  const paths: string[] = []
  const errors: unknown[] = []
  const waiters = new Map<string, () => void>()
  const watch = watchFolderTree(root, {
    maxDepth,
    isIgnored: (relativePath) => relativePath.split('/').includes(IGNORED_FOLDER_NAME),
    onChange: (relativePath) => {
      paths.push(relativePath)
      waiters.get(relativePath)?.()
    },
    onError: (error) => errors.push(error),
  })
  const reported = (path: string): Promise<void> => {
    if (paths.includes(path)) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${path} was not reported; got: ${paths.join(', ')}`)), EVENT_TIMEOUT_MS)
      waiters.set(path, () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
  return { watch, recorder: { paths, errors, reported } }
}

const quietWindow = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, QUIET_WINDOW_MS))

test('a new file in a nested folder is reported by its tree path', async () => {
  const root = makeTempDir('pi-ftw-nested-')
  await mkdir(join(root, 'src', 'lib'), { recursive: true })
  const { watch, recorder } = startRecording(root)
  await watch.ready
  try {
    await writeFile(join(root, 'src', 'lib', 'a.ts'), 'a')
    await recorder.reported('src/lib/a.ts')
  } finally {
    watch.close()
  }
})

test('a content change to an existing file is reported', async () => {
  const root = makeTempDir('pi-ftw-change-')
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src', 'a.ts'), 'old')
  const { watch, recorder } = startRecording(root)
  await watch.ready
  try {
    await writeFile(join(root, 'src', 'a.ts'), 'new')
    await recorder.reported('src/a.ts')
  } finally {
    watch.close()
  }
})

test('folders made after the start are watched, also when made several levels at once', async () => {
  const root = makeTempDir('pi-ftw-new-folder-')
  const { watch, recorder } = startRecording(root)
  await watch.ready
  try {
    await mkdir(join(root, 'a', 'b'), { recursive: true })
    await recorder.reported('a')
    // Let the watcher add the new folders before a file lands in the deepest one.
    await quietWindow()
    await writeFile(join(root, 'a', 'b', 'c.txt'), 'c')
    await recorder.reported('a/b/c.txt')
  } finally {
    watch.close()
  }
})

test('a folder removed and made again is still watched', async () => {
  const root = makeTempDir('pi-ftw-remake-')
  await mkdir(join(root, 'work'))
  const { watch, recorder } = startRecording(root)
  await watch.ready
  try {
    await rm(join(root, 'work'), { recursive: true })
    await mkdir(join(root, 'work'))
    await quietWindow()
    await writeFile(join(root, 'work', 'after.txt'), 'x')
    await recorder.reported('work/after.txt')
  } finally {
    watch.close()
  }
})

test('folders below the deepest watched level are not watched', async () => {
  const root = makeTempDir('pi-ftw-depth-')
  const maxDepth = 2
  await mkdir(join(root, 'l1', 'l2', 'l3'), { recursive: true })
  const { watch, recorder } = startRecording(root, maxDepth)
  await watch.ready
  try {
    await writeFile(join(root, 'l1', 'l2', 'l3', 'too-deep.txt'), 'x')
    await writeFile(join(root, 'l1', 'l2', 'in-reach.txt'), 'x')
    await recorder.reported('l1/l2/in-reach.txt')
    await quietWindow()
    assert.equal(recorder.paths.includes('l1/l2/l3/too-deep.txt'), false)
  } finally {
    watch.close()
  }
})

test('ignored folders and everything in them are not reported', async () => {
  const root = makeTempDir('pi-ftw-ignored-')
  await mkdir(join(root, IGNORED_FOLDER_NAME, 'pkg'), { recursive: true })
  const { watch, recorder } = startRecording(root)
  await watch.ready
  try {
    await writeFile(join(root, IGNORED_FOLDER_NAME, 'pkg', 'index.js'), 'x')
    await mkdir(join(root, 'app', IGNORED_FOLDER_NAME), { recursive: true })
    await quietWindow()
    await writeFile(join(root, 'app', IGNORED_FOLDER_NAME, 'late.js'), 'x')
    await writeFile(join(root, 'seen.txt'), 'x')
    await recorder.reported('seen.txt')
    await quietWindow()
    assert.deepEqual(recorder.paths.filter((path) => path.split('/').includes(IGNORED_FOLDER_NAME)), [])
  } finally {
    watch.close()
  }
})

test('a symlinked folder is not followed', async (t) => {
  const root = makeTempDir('pi-ftw-symlink-')
  const target = makeTempDir('pi-ftw-symlink-target-')
  try {
    await symlink(target, join(root, 'alias'))
  } catch (error) {
    // Windows needs elevation for symlinks; this watcher runs on Linux only.
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
    t.skip('creating a symlink requires elevation on this platform')
    return
  }
  const { watch, recorder } = startRecording(root)
  await watch.ready
  try {
    await writeFile(join(target, 'behind-link.txt'), 'x')
    await quietWindow()
    assert.deepEqual(recorder.paths, [])
  } finally {
    watch.close()
  }
})

test('nothing is reported after close', async () => {
  const root = makeTempDir('pi-ftw-close-')
  await mkdir(join(root, 'src'))
  const { watch, recorder } = startRecording(root)
  await watch.ready
  watch.close()
  await writeFile(join(root, 'src', 'late.txt'), 'x')
  await writeFile(join(root, 'top.txt'), 'x')
  await quietWindow()
  assert.deepEqual(recorder.paths, [])
})

test('a missing root reports one error and is ready', async () => {
  const root = join(makeTempDir('pi-ftw-missing-'), 'gone')
  const { watch, recorder } = startRecording(root)
  await watch.ready
  watch.close()
  assert.equal(recorder.errors.length, 1)
  assert.equal((recorder.errors[0] as NodeJS.ErrnoException).code, 'ENOENT')
})
