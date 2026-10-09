import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import {
  REPO_MAP_PROMPT_TAG,
  appendToSystemPrompt,
  describeRepoSetChange,
  expandAgentPath,
  formatRepoMapPrompt,
  loadRepoMap,
  locateToolCall,
  parseRepoMap,
  serializeRepoMap,
  toolCallPaths,
  type RepoSetContext,
} from './repo-set-map'

const ROOT = join(tmpdir(), 'repo-set-map')
const APP = join(ROOT, 'shop-app')
const LIB = join(ROOT, 'shop-lib')
const NESTED = join(APP, 'vendor', 'shop-lib')
const POSIX_HOME = '/home/me'
const WINDOWS_HOME = 'C:\\Users\\me'
const AST_OPS = [{ pat: 'oldName($A)', out: 'newName($A)' }]
const HASHLINE_INPUT = '@@ multi-file hashline edit body'
// Windows needs elevation for symlinks; the checks stay POSIX-tested.
const SKIP_WITHOUT_SYMLINKS = process.platform === 'win32'

const CONTEXT: RepoSetContext = {
  setName: 'Shop',
  mode: 'isolated',
  repos: [
    { name: 'shop-app', role: 'main', workPath: APP, branch: 'pi/rename-api-1', trusted: true },
    { name: 'shop-lib', role: 'linked', workPath: LIB, branch: 'pi/rename-api-1', trusted: false },
  ],
}

test('a serialized repo map parses back to the same context', () => {
  assert.deepEqual(parseRepoMap(JSON.parse(serializeRepoMap(CONTEXT))), CONTEXT)
})

test('parseRepoMap rejects a wrong version, a bad mode, a bad entry, or not exactly one main repo', () => {
  const valid = JSON.parse(serializeRepoMap(CONTEXT)) as Record<string, unknown>
  assert.equal(parseRepoMap({ ...valid, version: 2 }), null)
  assert.equal(parseRepoMap({ ...valid, mode: 'copy' }), null)
  assert.equal(parseRepoMap({ ...valid, repos: [{ ...CONTEXT.repos[0], trusted: 'yes' }] }), null)
  assert.equal(parseRepoMap({ ...valid, repos: CONTEXT.repos.map((repo) => ({ ...repo, role: 'linked' })) }), null)
  assert.equal(parseRepoMap({ ...valid, repos: CONTEXT.repos.map((repo) => ({ ...repo, role: 'main' })) }), null)
  assert.equal(parseRepoMap(null), null)
})

test('loadRepoMap re-reads a changed file and treats a missing or malformed one as no context', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'repo-map-'))
  const file = join(dir, 'map.json')
  assert.equal(loadRepoMap(file), null)

  await writeFile(file, serializeRepoMap(CONTEXT), 'utf-8')
  assert.equal(loadRepoMap(file)?.repos.length, 2)

  const added: RepoSetContext = {
    ...CONTEXT,
    repos: [...CONTEXT.repos, { name: 'shop-docs', role: 'linked', workPath: join(ROOT, 'docs'), branch: null, trusted: false }],
  }
  await writeFile(file, serializeRepoMap(added), 'utf-8')
  const later = new Date(Date.now() + 5_000)
  await utimes(file, later, later)
  assert.equal(loadRepoMap(file)?.repos.length, 3)

  await writeFile(file, '{ not json', 'utf-8')
  const latest = new Date(Date.now() + 10_000)
  await utimes(file, latest, latest)
  assert.equal(loadRepoMap(file), null)
})

test('expandAgentPath expands the prefixes Pi and OMP expand before they write', () => {
  const expand = (text: string): string | null => expandAgentPath(text, 'linux', POSIX_HOME)
  assert.equal(expand('~'), POSIX_HOME)
  assert.equal(expand('~/.bashrc'), '/home/me/.bashrc')
  assert.equal(expand('@/etc/hosts'), '/etc/hosts')
  assert.equal(expand('@src/a.ts'), 'src/a.ts')
  assert.equal(expand('@~/.bashrc'), '/home/me/.bashrc')
  assert.equal(expand('file:///etc/hosts'), '/etc/hosts')
  assert.equal(expand('src/a\u00A0b.ts'), 'src/a b.ts')
  assert.equal(expand('src/~/a.ts'), 'src/~/a.ts')
  assert.equal(expand('/etc/hosts'), '/etc/hosts')
})

test('expandAgentPath gives null for a form an engine may read another way', () => {
  for (const text of ['~other/.bashrc', '~\\.bashrc', '@@/etc/hosts', 'file:/etc/hosts', 'FILE:///etc/hosts', 'file://host/etc/hosts', 'local://notes.md']) {
    assert.equal(expandAgentPath(text, 'linux', POSIX_HOME), null, text)
  }
})

test('expandAgentPath reads the Windows forms on win32', () => {
  const expand = (text: string): string | null => expandAgentPath(text, 'win32', WINDOWS_HOME)
  assert.equal(expand('~\\.bashrc'), 'C:\\Users\\me\\.bashrc')
  assert.equal(expand('~/.bashrc'), 'C:\\Users\\me\\.bashrc')
  assert.equal(expand('file:///C:/Users/me/a.txt'), 'C:\\Users\\me\\a.txt')
  assert.equal(expand('file://server/share/a.txt'), '\\\\server\\share\\a.txt')
  assert.equal(expand('C:\\repo\\a.ts'), 'C:\\repo\\a.ts')
  // Pi maps Git Bash, MSYS, Cygwin, and WSL drive paths to a drive; OMP may not.
  for (const text of ['/c/Users/me/a.txt', '/mnt/c/a.txt', '/cygdrive/c/a.txt', '/c']) {
    assert.equal(expand(text), null, text)
  }
})

test('toolCallPaths names every file a write touches, in the Pi and OMP shapes', () => {
  assert.deepEqual(toolCallPaths('write', { path: 'a.ts', content: 'x' }), ['a.ts'])
  assert.deepEqual(toolCallPaths('edit', { path: 'a.ts', edits: [{ oldText: 'a', newText: 'b' }] }), ['a.ts'])
  assert.deepEqual(toolCallPaths('ast_edit', { ops: AST_OPS, paths: ['src/**/*.ts', 'lib/*.ts'] }), ['src/**/*.ts', 'lib/*.ts'])
  assert.deepEqual(toolCallPaths('edit', { input: HASHLINE_INPUT, paths: ['a.ts', 'b.ts'] }), ['a.ts', 'b.ts'])
  assert.deepEqual(toolCallPaths('edit', { path: 'a.ts', edits: [{ op: 'update', rename: 'b.ts' }] }), ['a.ts', 'b.ts'])
  assert.deepEqual(toolCallPaths('edit', { path: 'a.ts', rename: 'b.ts' }), ['a.ts', 'b.ts'])
  assert.deepEqual(toolCallPaths('write', { content: 'x' }), [])
})

test('toolCallPaths gives null when a path field of a write holds something other than text', () => {
  assert.equal(toolCallPaths('edit', { input: HASHLINE_INPUT, paths: 'a.ts' }), null)
  assert.equal(toolCallPaths('edit', { input: HASHLINE_INPUT, paths: ['a.ts', 7] }), null)
  assert.equal(toolCallPaths('write', { path: ['a.ts'], content: 'x' }), null)
  assert.equal(toolCallPaths('edit', { path: 'a.ts', edits: 'rename a.ts b.ts' }), null)
  assert.equal(toolCallPaths('edit', { path: 'a.ts', edits: [{ op: 'update', rename: 7 }] }), null)
})

test('toolCallPaths reads only the path of other tools, the input the rules match', () => {
  assert.deepEqual(toolCallPaths('read', { path: 'a.ts' }), ['a.ts'])
  assert.deepEqual(toolCallPaths('grep', { pattern: 'x', paths: ['a', 'b'] }), [])
  assert.deepEqual(toolCallPaths('bash', { command: 'ls' }), [])
})

function repoNames(context: RepoSetContext, toolName: string, input: unknown): (string | null)[] {
  return locateToolCall(context, toolName, input, APP).repos.map((repo) => repo?.name ?? null)
}

function leavesRepoSet(toolName: string, input: unknown): boolean {
  return locateToolCall(CONTEXT, toolName, input, APP).leavesRepoSet
}

test('locateToolCall maps each path to its checkout, the deepest one first', () => {
  assert.deepEqual(repoNames(CONTEXT, 'read', { path: 'src/index.ts' }), ['shop-app'])
  assert.deepEqual(repoNames(CONTEXT, 'read', { path: join(LIB, 'api.ts') }), ['shop-lib'])
  assert.deepEqual(repoNames(CONTEXT, 'read', { path: '../shop-lib/api.ts' }), ['shop-lib'])
  assert.deepEqual(repoNames(CONTEXT, 'read', { path: '../shop-lib-secrets/key.pem' }), [null])
  assert.deepEqual(repoNames(CONTEXT, 'read', { path: '../../outside.txt' }), [null])
  assert.deepEqual(repoNames(CONTEXT, 'read', { path: '~/.ssh/id_rsa' }), [null])
  assert.deepEqual(repoNames(CONTEXT, 'edit', { input: HASHLINE_INPUT, paths: ['src/a.ts', '../shop-lib/b.ts', 'src/c.ts'] }), ['shop-app', 'shop-lib'])
  assert.deepEqual(repoNames(CONTEXT, 'bash', { command: 'ls ../shop-lib' }), [])

  const nested: RepoSetContext = {
    ...CONTEXT,
    repos: [...CONTEXT.repos, { name: 'vendored', role: 'linked', workPath: NESTED, branch: null, trusted: false }],
  }
  assert.deepEqual(repoNames(nested, 'read', { path: join(NESTED, 'a.ts') }), ['vendored'])
  // A glob also reaches every checkout nested under its folder.
  assert.deepEqual(repoNames(nested, 'ast_edit', { ops: AST_OPS, paths: ['vendor/**/*.ts'] }), ['shop-app', 'vendored'])
})

test('a write leaves the set when the engine expands its path to a place outside every checkout', () => {
  for (const path of ['~', '~/.bashrc', '@/etc/hosts', 'file:///etc/hosts', '~other/.bashrc', '@@src/a.ts', '../../outside.txt', '/etc/hosts', join(ROOT, 'other', 'a.ts')]) {
    assert.equal(leavesRepoSet('write', { path, content: 'x' }), true, path)
  }
  for (const path of ['src/a.ts', '@src/a.ts', '../shop-lib/a.ts', join(LIB, 'a.ts'), pathToFileURL(join(LIB, 'a.ts')).href]) {
    assert.equal(leavesRepoSet('write', { path, content: 'x' }), false, path)
  }
})

test('every path a write names must be inside a checkout: OMP paths, multi-file edits, renames', () => {
  assert.equal(leavesRepoSet('ast_edit', { ops: AST_OPS, paths: ['src/**/*.ts', '../shop-lib/**/*.ts'] }), false)
  assert.equal(leavesRepoSet('ast_edit', { ops: AST_OPS, paths: ['src/**/*.ts', '/etc/**/*.conf'] }), true)
  assert.equal(leavesRepoSet('ast_edit', { ops: AST_OPS, path: '/etc/hosts' }), true)
  assert.equal(leavesRepoSet('edit', { input: HASHLINE_INPUT, paths: ['src/a.ts', '../shop-lib/b.ts'] }), false)
  assert.equal(leavesRepoSet('edit', { input: HASHLINE_INPUT, paths: ['src/a.ts', '/etc/hosts'] }), true)
  assert.equal(leavesRepoSet('edit', { path: 'src/a.ts', edits: [{ op: 'update', rename: 'src/b.ts' }] }), false)
  assert.equal(leavesRepoSet('edit', { path: 'src/a.ts', edits: [{ op: 'update', rename: '/etc/moved.ts' }] }), true)
  assert.equal(leavesRepoSet('edit', { path: 'src/a.ts', rename: '~/moved.ts' }), true)
})

test('a glob whose matches can leave its folder leaves the set', () => {
  assert.equal(leavesRepoSet('ast_edit', { ops: AST_OPS, paths: ['src/**/*.{ts,tsx}'] }), false)
  assert.equal(leavesRepoSet('ast_edit', { ops: AST_OPS, paths: ['{src,test}/**/*.ts'] }), false)
  assert.equal(leavesRepoSet('ast_edit', { ops: AST_OPS, paths: ['{src,/etc}/*.conf'] }), true)
  assert.equal(leavesRepoSet('ast_edit', { ops: AST_OPS, paths: ['src/**/../../x.ts'] }), true)
  assert.equal(leavesRepoSet('ast_edit', { ops: AST_OPS, paths: ['/*/hosts'] }), true)
})

test('a write with no path to check leaves the set; reads and shell commands never do', () => {
  assert.equal(leavesRepoSet('write', { content: 'x' }), true)
  assert.equal(leavesRepoSet('ast_edit', { ops: AST_OPS }), true)
  assert.equal(leavesRepoSet('edit', { input: HASHLINE_INPUT, paths: 'src/a.ts' }), true)
  assert.equal(leavesRepoSet('write', null), true)
  assert.equal(leavesRepoSet('read', { path: '/etc/hosts' }), false)
  assert.equal(leavesRepoSet('bash', { command: 'cp notes.txt ~/.bashrc' }), false)
})

test('a symlink inside a checkout that leads outside it leaves the set', { skip: SKIP_WITHOUT_SYMLINKS }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'repo-set-links-'))
  try {
    const app = join(root, 'app')
    const outside = join(root, 'outside')
    await mkdir(join(app, 'src'), { recursive: true })
    await mkdir(outside)
    await writeFile(join(outside, 'secret.txt'), 'secret\n')
    await symlink(join(outside, 'secret.txt'), join(app, 'secret-link.txt'))
    await symlink(outside, join(app, 'outside-dir'), 'dir')
    await symlink(join(outside, 'missing.txt'), join(app, 'dangling.txt'))
    await symlink(join(app, 'src'), join(app, 'src-link'), 'dir')
    const context: RepoSetContext = {
      setName: 'Shop',
      mode: 'inPlace',
      repos: [{ name: 'app', role: 'main', workPath: app, branch: null, trusted: false }],
    }
    const leaves = (path: string): boolean => locateToolCall(context, 'write', { path, content: 'x' }, app).leavesRepoSet
    assert.equal(leaves('src/a.ts'), false)
    assert.equal(leaves('src-link/a.ts'), false)
    assert.equal(leaves('secret-link.txt'), true)
    assert.equal(leaves('outside-dir/new.txt'), true)
    assert.equal(leaves('dangling.txt'), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('checkouts reached through a symlinked folder keep their relative paths', { skip: SKIP_WITHOUT_SYMLINKS }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'repo-set-data-link-'))
  try {
    const realData = join(root, 'data')
    const dataLink = join(root, 'data-link')
    await mkdir(join(realData, 'app', 'src'), { recursive: true })
    await mkdir(join(realData, 'lib'), { recursive: true })
    await symlink(realData, dataLink, 'dir')
    // The map holds the paths through the link; the agent runs in the real path.
    const context: RepoSetContext = {
      setName: 'Shop',
      mode: 'isolated',
      repos: [
        { name: 'app', role: 'main', workPath: join(dataLink, 'app'), branch: 'pi/x', trusted: false },
        { name: 'lib', role: 'linked', workPath: join(dataLink, 'lib'), branch: 'pi/x', trusted: false },
      ],
    }
    const cwd = await realpath(join(dataLink, 'app'))
    const [app, lib] = context.repos
    assert.deepEqual(locateToolCall(context, 'edit', { path: 'src/index.ts', edits: [] }, cwd), { repos: [app], leavesRepoSet: false })
    assert.deepEqual(locateToolCall(context, 'write', { path: '../lib/a.ts', content: 'x' }, cwd), { repos: [lib], leavesRepoSet: false })
    assert.deepEqual(locateToolCall(context, 'write', { path: join(dataLink, 'lib', 'a.ts'), content: 'x' }, cwd), { repos: [lib], leavesRepoSet: false })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the prompt block lists every repository with its role, path, and branch', () => {
  const prompt = formatRepoMapPrompt(CONTEXT, (path) => path === join(LIB, 'AGENTS.md'))
  assert.ok(prompt.startsWith(`<${REPO_MAP_PROMPT_TAG}>`))
  assert.ok(prompt.endsWith(`</${REPO_MAP_PROMPT_TAG}>`))
  assert.match(prompt, /"Shop"/)
  assert.ok(prompt.includes(`- shop-app (main repository, your working directory): ${APP} — branch pi/rename-api-1`))
  assert.ok(prompt.includes(`- shop-lib (linked repository): ${LIB} — branch pi/rename-api-1; read its rules in ${join(LIB, 'AGENTS.md')}`))

  const inPlace = formatRepoMapPrompt({ ...CONTEXT, mode: 'inPlace', repos: [{ ...CONTEXT.repos[0], branch: null }] }, () => false)
  assert.match(inPlace, /edited in place/)
  assert.match(inPlace, /detached HEAD/)
})

test('appendToSystemPrompt keeps the shape each engine uses', () => {
  assert.equal(appendToSystemPrompt('base', 'block'), 'base\n\nblock')
  assert.deepEqual(appendToSystemPrompt(['a', 'b'], 'block'), ['a', 'b', 'block'])
})

test('describeRepoSetChange names added and removed checkouts, and nothing when the list is the same', () => {
  assert.equal(describeRepoSetChange(CONTEXT, { ...CONTEXT }), null)
  const docs = { name: 'shop-docs', role: 'linked' as const, workPath: join(ROOT, 'docs'), branch: 'pi/rename-api-1', trusted: false }
  const added = describeRepoSetChange(CONTEXT, { ...CONTEXT, repos: [...CONTEXT.repos, docs] }) ?? ''
  assert.match(added, /now current/)
  assert.ok(added.includes(`Added: shop-docs at ${docs.workPath} (branch pi/rename-api-1). Include it in the task from now on.`))
  const removed = describeRepoSetChange(CONTEXT, { ...CONTEXT, repos: [CONTEXT.repos[0]] }) ?? ''
  assert.ok(removed.includes(`Removed: shop-lib at ${LIB}.`))
})
