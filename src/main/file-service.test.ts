import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, mkdir, readFile, symlink } from 'fs/promises'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import {
  buildNewFileDiff,
  describeGitError,
  FileService,
  isBenignGitError,
  isIgnoredDirName,
  isIgnoredHomeRootDirName,
  isPathInsideWorkspace,
  isUnlistableEntryError,
} from './file-service'
import { commitAll } from './git-conveyor'
import { gitDiffPaths, splitGitDiff } from '../shared/git-diff'
import type { FileChangeEvent, FileTreeNode } from '../shared/ipc-contracts'
import { i18n, tEnglish } from '../shared/i18n'
import { PSEUDO_LANGUAGE, SOURCE_LANGUAGE } from '../shared/i18n/languages'

// ─── Path-boundary guard ──────────────────────────────────────────────────

test('isPathInsideWorkspace allows in-workspace relative and absolute paths', () => {
  assert.equal(isPathInsideWorkspace('/work', 'src/a.ts'), true)
  assert.equal(isPathInsideWorkspace('/work', '/work/src/a.ts'), true)
})

test('isPathInsideWorkspace rejects traversal and outside-absolute paths', () => {
  assert.equal(isPathInsideWorkspace('/work', '../secret'), false)
  assert.equal(isPathInsideWorkspace('/work', 'src/../../secret'), false)
  assert.equal(isPathInsideWorkspace('/work', '/etc/passwd'), false)
  assert.equal(isPathInsideWorkspace('/work', '/work'), false) // the root itself
})

test('readFileContent reads inside the workspace but refuses traversal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-fs-read-'))
  await writeFile(join(dir, 'ok.txt'), 'inside')
  const service = new FileService(dir)
  assert.equal(await service.readFileContent('ok.txt'), 'inside')
  await assert.rejects(() => service.readFileContent('../../../etc/passwd'), /outside the active workspace/)
  await assert.rejects(() => service.readFileContent('/etc/passwd'), /outside the active workspace/)
})

test('writeFileContent writes inside the workspace but refuses traversal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-fs-write-'))
  const service = new FileService(dir)
  await service.writeFileContent('out.txt', 'data')
  assert.equal(await readFile(join(dir, 'out.txt'), 'utf-8'), 'data')
  await assert.rejects(() => service.writeFileContent('../escape.txt', 'x'), /outside the active workspace/)
})

const diff = buildNewFileDiff('TEST.md', '# Test\n\nHello\n')

assert.equal(
  diff,
  [
    'diff --git a/TEST.md b/TEST.md',
    'new file mode 100644',
    'index 0000000..0000000',
    '--- /dev/null',
    '+++ b/TEST.md',
    '@@ -0,0 +1,3 @@',
    '+# Test',
    '+',
    '+Hello',
    '',
  ].join('\n')
)

// ─── startWatching ────────────────────────────────────────────────────────

function waitForChange(timeoutMs: number): {
  promise: Promise<FileChangeEvent[]>
  onChange: (event: FileChangeEvent) => void
} {
  const events: FileChangeEvent[] = []
  let resolve!: (value: FileChangeEvent[]) => void
  const promise = new Promise<FileChangeEvent[]>((res) => {
    resolve = res
  })
  const onChange = (event: FileChangeEvent): void => {
    events.push(event)
    resolve(events)
  }
  setTimeout(() => resolve(events), timeoutMs)
  return { promise, onChange }
}

async function testWatcherEmitsOnChange(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-fs-watch-'))
  const service = new FileService(dir)
  const { promise, onChange } = waitForChange(3000)

  service.startWatching(onChange)
  // Give chokidar a moment to finish its initial scan before mutating.
  await new Promise((r) => setTimeout(r, 300))
  await writeFile(join(dir, 'hello.txt'), 'hi')

  const events = await promise
  service.stopWatching()

  assert.ok(events.length > 0, 'expected at least one debounced file-change event')
  assert.equal(events[events.length - 1].relativePath, 'hello.txt')
}

async function testWatcherIgnoresHeavyDirs(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-fs-ignore-'))
  await mkdir(join(dir, 'node_modules'), { recursive: true })
  const service = new FileService(dir)
  const { promise, onChange } = waitForChange(1500)

  service.startWatching(onChange)
  await new Promise((r) => setTimeout(r, 300))
  await writeFile(join(dir, 'node_modules', 'ignored.js'), 'x')

  const events = await promise
  service.stopWatching()

  assert.equal(events.length, 0, 'changes under node_modules must not emit events')
}

async function testWatcherDoesNotFollowSymlinks(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-fs-symlink-'))
  const target = await mkdtemp(join(tmpdir(), 'pi-fs-symlink-target-'))
  await symlink(target, join(dir, 'alias'), 'dir')
  const service = new FileService(dir)
  const { promise, onChange } = waitForChange(1500)

  service.startWatching(onChange)
  await new Promise((r) => setTimeout(r, 300))
  await writeFile(join(target, 'inside-target.txt'), 'x')

  const events = await promise
  service.stopWatching()

  const reported = events.map((event) => event.relativePath)
  assert.ok(
    reported.every((path) => !path.includes('inside-target.txt')),
    `files behind a symlinked directory must not be reported, got: ${reported.join(', ')}`
  )
}

test('watcher emits a debounced change event', testWatcherEmitsOnChange)
test('watcher ignores heavy dirs like node_modules', testWatcherIgnoresHeavyDirs)
test('watcher does not descend into symlinked directories', testWatcherDoesNotFollowSymlinks)

// ─── Ignored directory names ──────────────────────────────────────────────

test('isIgnoredDirName ignores build artifacts but not project tooling folders', () => {
  assert.equal(isIgnoredDirName('node_modules'), true)
  assert.equal(isIgnoredDirName('src'), false)
  assert.equal(isIgnoredDirName('.cargo'), false)
  assert.equal(isIgnoredDirName('.yarn'), false)
  assert.equal(isIgnoredDirName('templates'), false)
})

test('isIgnoredHomeRootDirName ignores home tooling stores on every platform', () => {
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    assert.equal(isIgnoredHomeRootDirName('.npm', platform), true)
    assert.equal(isIgnoredHomeRootDirName('.cargo', platform), true)
    assert.equal(isIgnoredHomeRootDirName('.codex', platform), true)
    assert.equal(isIgnoredHomeRootDirName('.local', platform), true)
    assert.equal(isIgnoredHomeRootDirName('Projects', platform), false)
  }
})

test('isIgnoredHomeRootDirName ignores the macOS Library folder only on darwin', () => {
  assert.equal(isIgnoredHomeRootDirName('Library', 'darwin'), true)
  assert.equal(isIgnoredHomeRootDirName('Library', 'linux'), false)
  assert.equal(isIgnoredHomeRootDirName('Library', 'win32'), false)
})

test('isIgnoredHomeRootDirName ignores Windows profile folders only on win32', () => {
  assert.equal(isIgnoredHomeRootDirName('AppData', 'win32'), true)
  assert.equal(isIgnoredHomeRootDirName('ntuser.dat', 'win32'), true)
  assert.equal(isIgnoredHomeRootDirName('Templates', 'win32'), true)
  assert.equal(isIgnoredHomeRootDirName('AppData', 'linux'), false)
  assert.equal(isIgnoredHomeRootDirName('AppData', 'darwin'), false)
})

async function makeToolingWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-fs-tooling-'))
  await mkdir(join(dir, '.cargo'), { recursive: true })
  await writeFile(join(dir, '.cargo', 'config.toml'), '[build]')
  await mkdir(join(dir, 'Projects', 'app', '.cargo'), { recursive: true })
  await writeFile(join(dir, 'Projects', 'app', '.cargo', 'config.toml'), '[build]')
  return dir
}

function childNames(node: FileTreeNode): string[] {
  return (node.children ?? []).map((child) => child.name)
}

test('project workspaces keep tooling folders in the tree and in search', async () => {
  const dir = await makeToolingWorkspace()
  const service = new FileService(dir, join(dir, 'not-home'))
  const tree = await service.getFileTree()
  assert.ok(childNames(tree).includes('.cargo'))
  const found = await service.searchFiles('config.toml')
  assert.deepEqual(found.map((hit) => hit.relativePath).sort(), ['.cargo/config.toml', 'Projects/app/.cargo/config.toml'])
})

test('a home workspace hides tooling stores only at its root', async () => {
  const dir = await makeToolingWorkspace()
  const service = new FileService(dir, dir)
  const tree = await service.getFileTree()
  assert.equal(childNames(tree).includes('.cargo'), false)
  const found = await service.searchFiles('config.toml')
  assert.deepEqual(found.map((hit) => hit.relativePath), ['Projects/app/.cargo/config.toml'])
})

test('an entry that cannot be listed hides only itself, not the rest of its folder', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-fs-dangling-'))
  await mkdir(join(dir, 'folder'))
  for (const name of ['b.txt', 'c.txt']) {
    await writeFile(join(dir, name), name)
    await writeFile(join(dir, 'folder', name), name)
  }
  try {
    // Sorted before the files, so its failed stat used to end the listing.
    await symlink(join(dir, 'missing-target'), join(dir, 'a-dangling'))
    await symlink(join(dir, 'missing-target'), join(dir, 'folder', 'a-dangling'))
  } catch (error) {
    // Windows needs elevation for symlinks; the listing itself stays POSIX-tested.
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
    t.skip('creating a symlink requires elevation on this platform')
    return
  }
  const tree = await new FileService(dir, join(dir, 'not-home')).getFileTree()
  assert.deepEqual(childNames(tree), ['folder', 'b.txt', 'c.txt'])
  assert.deepEqual(childNames(tree.children!.find((child) => child.name === 'folder')!), ['b.txt', 'c.txt'])
})

// A stale network or FUSE mount (ENOTCONN, ESTALE), a disk error (EIO) or an
// odd Windows code must cost one entry, not the whole tree.
test('any file system error leaves out only its entry; a program error is not hidden', () => {
  for (const code of ['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM', 'EBUSY', 'ENOTCONN', 'ESTALE', 'EIO', 'EINVAL', 'UNKNOWN']) {
    assert.equal(isUnlistableEntryError(Object.assign(new Error(code), { code })), true, code)
  }
  assert.equal(isUnlistableEntryError(new TypeError('a bug')), false)
  assert.equal(isUnlistableEntryError(null), false)
})

test('Git config files show in the tree and in search, the .git folder does not', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-fs-git-files-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  await writeFile(join(dir, '.gitignore'), 'out\n')
  await mkdir(join(dir, '.github', 'workflows'), { recursive: true })
  await writeFile(join(dir, '.github', 'workflows', 'ci.yml'), 'on: push\n')
  const service = new FileService(dir, join(dir, 'not-home'))
  const tree = await service.getFileTree()
  assert.deepEqual(childNames(tree).sort(), ['.github', '.gitignore'])
  const found = await service.searchFiles('i')
  assert.deepEqual(found.map((hit) => hit.relativePath).sort(), ['.github/workflows/ci.yml', '.gitignore'])
})

async function testHomeWatcherIgnoresRootToolingOnly(): Promise<void> {
  const dir = await makeToolingWorkspace()
  const service = new FileService(dir, dir)
  const { promise, onChange } = waitForChange(3000)

  service.startWatching(onChange)
  await new Promise((r) => setTimeout(r, 300))
  await writeFile(join(dir, '.cargo', 'ignored.toml'), 'x')
  await new Promise((r) => setTimeout(r, 800))
  await writeFile(join(dir, 'Projects', 'app', '.cargo', 'seen.toml'), 'x')

  const events = await promise
  service.stopWatching()

  assert.deepEqual(events.map((event) => event.relativePath), ['Projects/app/.cargo/seen.toml'])
}

test('home watcher ignores root tooling stores but watches nested ones', testHomeWatcherIgnoresRootToolingOnly)

// ─── Git error classification ─────────────────────────────────────────────

test('isBenignGitError accepts not-a-repo stderr and missing git binary', () => {
  assert.equal(
    isBenignGitError({ stderr: 'fatal: not a git repository (or any of the parent directories): .git\n' }),
    true,
  )
  assert.equal(isBenignGitError({ code: 'ENOENT', message: 'spawn git ENOENT' }), true)
  assert.equal(isBenignGitError({ message: 'fatal: Not a git repository' }), true)
})

test('isBenignGitError rejects real git failures', () => {
  assert.equal(isBenignGitError({ code: 128, stderr: 'fatal: bad object HEAD\n' }), false)
  assert.equal(isBenignGitError({ killed: true, signal: 'SIGTERM', message: 'timeout' }), false)
  assert.equal(isBenignGitError(null), false)
  assert.equal(isBenignGitError('string error'), false)
})

test('describeGitError prefers the first stderr line over the message', () => {
  assert.equal(
    describeGitError('status', { stderr: 'fatal: bad object HEAD\nmore context\n', message: 'exited 128' }),
    'git status failed: fatal: bad object HEAD',
  )
  assert.equal(describeGitError('diff', { message: 'timed out' }), 'git diff failed: timed out')
})

test('describeGitError renders English for the log and marked text for the UI', async () => {
  const err = { stderr: 'fatal: bad object HEAD\n' }
  await i18n.changeLanguage(PSEUDO_LANGUAGE)
  try {
    assert.equal(describeGitError('status', err, tEnglish), 'git status failed: fatal: bad object HEAD')
    // Only the app's own words are marked; the command and Git's text are not.
    assert.match(describeGitError('status', err), /^\[git status ƒáîļéð: fatal: bad object HEAD ~+\]$/)
  } finally {
    await i18n.changeLanguage(SOURCE_LANGUAGE)
  }
})

test('getGitStatus returns empty for a non-repo directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fs-nonrepo-'))
  const service = new FileService(dir)
  const status = await service.getGitStatus()
  assert.equal(status.size, 0)
})

test('getFileDiff and getStagedDiff return empty for a non-repo directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fs-nonrepo-'))
  const service = new FileService(dir)
  assert.equal(await service.getFileDiff(), '')
  assert.equal(await service.getStagedDiff(), '')
})

test('getGitPrefix reports the workspace directory inside its repository', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'fs-prefix-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  const subfolder = join(repo, 'pkg', 'app')
  await mkdir(subfolder, { recursive: true })
  assert.equal(await new FileService(repo).getGitPrefix(), '')
  assert.equal(await new FileService(subfolder).getGitPrefix(), 'pkg/app/')
  assert.equal(await new FileService(await mkdtemp(join(tmpdir(), 'fs-nonrepo-'))).getGitPrefix(), '')
})

// Node's execFile default maxBuffer; a diff above it used to fail (#70).
const EXEC_FILE_DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024

test('getFileDiff and getStagedDiff return diffs larger than the execFile default buffer', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fs-bigdiff-'))
  const git = (...args: string[]): void => {
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd: dir })
  }
  git('init', '-q')
  await writeFile(join(dir, 'big.txt'), 'original\n')
  git('add', 'big.txt')
  git('commit', '-q', '-m', 'init')

  const bigContent = 'changed line of text\n'.repeat(EXEC_FILE_DEFAULT_MAX_BUFFER_BYTES / 10)
  await writeFile(join(dir, 'big.txt'), bigContent)
  const service = new FileService(dir)

  const workingDiff = await service.getFileDiff()
  assert.ok(workingDiff.length > EXEC_FILE_DEFAULT_MAX_BUFFER_BYTES)

  git('add', 'big.txt')
  const stagedDiff = await service.getStagedDiff()
  assert.ok(stagedDiff.length > EXEC_FILE_DEFAULT_MAX_BUFFER_BYTES)
})

test('a monorepo subfolder workspace reports its Git prefix and diffs only its own files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fs-monorepo-'))
  const git = (...args: string[]): void => {
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd: dir })
  }
  git('init', '-q')
  await writeFile(join(dir, 'tracked.ts'), 'original\n')
  git('add', 'tracked.ts')
  git('commit', '-q', '-m', 'init')
  const workspace = join(dir, 'pkg', 'app')
  await mkdir(join(workspace, 'src'), { recursive: true })
  await writeFile(join(workspace, 'src', 'new.ts'), 'inside\n')
  await writeFile(join(dir, 'root.ts'), 'outside\n')
  await writeFile(join(dir, 'tracked.ts'), 'changed outside\n')
  git('add', 'tracked.ts')
  await writeFile(join(dir, 'tracked.ts'), 'changed again outside\n')
  const service = new FileService(workspace)

  assert.equal(await service.getGitPrefix(), 'pkg/app/')
  const diff = await service.getFileDiff()
  assert.match(diff, /^diff --git a\/pkg\/app\/src\/new\.ts b\/pkg\/app\/src\/new\.ts$/m)
  assert.match(diff, /^\+inside$/m)
  assert.doesNotMatch(diff, /root\.ts|tracked\.ts/)
  assert.equal(await service.getStagedDiff(), '')
  assert.match(await service.getFileDiff('src/new.ts'), /pkg\/app\/src\/new\.ts/)
})

/**
 * Names Git quotes in a diff header (non-ASCII, `"`, `\`, control
 * characters), in a status row (space), or that make `a/X b/X` ambiguous
 * (` b/`). Windows file names cannot hold `"`, `\`, or control characters.
 */
const UNUSUAL_NAMES = [
  'Meeting notes.md', 'grüße.txt', 'x b/y.txt',
  ...(process.platform === 'win32' ? [] : ['say "hi".txt', 'back\\slash.txt', 'tab\there.txt', 'new\nline.txt', 'bell\u0007.txt']),
]
const UNUSUAL_NEW_FILE = 'neue Datei ü.txt'

async function unusualNamesRepo(): Promise<{ dir: string; git: (...args: string[]) => string; service: FileService }> {
  const dir = await mkdtemp(join(tmpdir(), 'fs-unusual-names-'))
  const git = (...args: string[]): string =>
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd: dir, encoding: 'utf8' })
  git('init', '-q')
  // Pinned locally so a global setting cannot turn rename detection off.
  git('config', 'diff.renames', 'true')
  git('config', 'status.renames', 'true')
  await mkdir(join(dir, 'x b'))
  for (const name of UNUSUAL_NAMES) await writeFile(join(dir, name), 'one\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  for (const name of UNUSUAL_NAMES) await writeFile(join(dir, name), 'one\ntwo\n')
  await writeFile(join(dir, UNUSUAL_NEW_FILE), 'new\n')
  return { dir, git, service: new FileService(dir) }
}

test('status keys and diff paths are the same raw repository paths for any file name', async () => {
  const { git, service } = await unusualNamesRepo()
  const status = await service.getGitStatus()
  assert.deepEqual([...status.keys()].sort(), [...UNUSUAL_NAMES, UNUSUAL_NEW_FILE].sort())
  assert.deepEqual(status.get(UNUSUAL_NEW_FILE), { index: '?', worktree: '?', isStaged: false })
  const working = splitGitDiff(await service.getFileDiff()).map(gitDiffPaths)
  assert.deepEqual(working.map((paths) => paths?.newPath).sort(), [...status.keys()].sort())

  git('mv', 'Meeting notes.md', 'Notizen ü.md')
  assert.deepEqual(splitGitDiff(await service.getStagedDiff()).map(gitDiffPaths), [
    { oldPath: 'Meeting notes.md', newPath: 'Notizen ü.md' },
  ])
  assert.equal((await service.getGitStatus()).get('Notizen ü.md')?.index, 'R')
})

test('a commit from the path list of the Diff view takes every file, whatever its name', async () => {
  const { dir, git, service } = await unusualNamesRepo()
  const selection = splitGitDiff(await service.getFileDiff())
    .map((patch) => gitDiffPaths(patch) ?? assert.fail(`no paths read from ${patch.split('\n', 1)[0]}`))
  const paths = [...new Set(selection.flatMap(({ oldPath, newPath }) => [oldPath, newPath]))]
  const newFiles = [...(await service.getGitStatus())].filter(([, status]) => status.index === '?').map(([path]) => path)
  assert.deepEqual(newFiles, [UNUSUAL_NEW_FILE])

  await commitAll(dir, { message: 'unusual names', paths, newFiles })
  assert.deepEqual(git('show', '--format=', '--name-only', '-z', 'HEAD').split('\0').filter(Boolean).sort(),
    [...UNUSUAL_NAMES, UNUSUAL_NEW_FILE].sort())
  assert.equal(git('status', '--porcelain'), '')
})

test('user Git diff settings do not change the form of the diffs the Diff view reads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fs-diff-config-'))
  const git = (...args: string[]): void => {
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd: dir })
  }
  git('init', '-q')
  const workspace = join(dir, 'pkg', 'app')
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'a.ts'), 'one\n\nthree\n')
  await writeFile(join(workspace, 'b.ts'), 'b\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  for (const [key, value] of [
    ['diff.noprefix', 'true'], ['diff.mnemonicPrefix', 'true'], ['diff.relative', 'true'], ['color.ui', 'always'],
    ['diff.external', 'echo'], ['diff.submodule', 'log'], ['diff.suppressBlankEmpty', 'true'],
  ]) git('config', key, value)
  await writeFile(join(workspace, 'a.ts'), 'one\n\nthree\nfour\n')
  await writeFile(join(workspace, 'b.ts'), 'b changed\n')
  git('add', 'pkg/app/b.ts')
  const service = new FileService(workspace)

  const working = await service.getFileDiff()
  assert.match(working, /^diff --git a\/pkg\/app\/a\.ts b\/pkg\/app\/a\.ts\n/)
  assert.match(working, /^ one\n \n three\n\+four$/m, 'a blank context line keeps its leading space')
  const staged = await service.getStagedDiff()
  assert.match(staged, /^diff --git a\/pkg\/app\/b\.ts b\/pkg\/app\/b\.ts\n/)
  for (const diff of [working, staged]) assert.equal(diff.includes(ANSI_ESCAPE), false)
})

const ANSI_ESCAPE = String.fromCharCode(0x1b)

test('a file diff names its file literally, never as a glob', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fs-literal-path-'))
  const git = (...args: string[]): void => {
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd: dir })
  }
  git('init', '-q')
  for (const name of ['[id].ts', 'd.ts', 'i.ts']) await writeFile(join(dir, name), 'one\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  for (const name of ['[id].ts', 'd.ts', 'i.ts']) await writeFile(join(dir, name), 'two\n')
  const patches = splitGitDiff(await new FileService(dir).getFileDiff('[id].ts'))
  assert.deepEqual(patches.map((patch) => gitDiffPaths(patch)?.newPath), ['[id].ts'])
})

test('a new-file patch quotes its path exactly the way Git does', () => {
  assert.match(buildNewFileDiff('grüße.txt', 'x\n'), /^diff --git "a\/gr\\303\\274\\303\\237e\.txt" "b\/gr\\303\\274\\303\\237e\.txt"\n/)
  assert.match(buildNewFileDiff('say "hi".txt', 'x\n'), /^\+\+\+ "b\/say \\"hi\\"\.txt"$/m)
  assert.match(buildNewFileDiff('plain name.txt', 'x\n'), /^diff --git a\/plain name\.txt b\/plain name\.txt\n/)
  for (const name of [...UNUSUAL_NAMES, UNUSUAL_NEW_FILE]) {
    assert.deepEqual(gitDiffPaths(buildNewFileDiff(name, 'x\n')), { oldPath: name, newPath: name }, name)
  }
})
