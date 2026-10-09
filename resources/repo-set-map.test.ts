import assert from 'node:assert/strict'
import { mkdtemp, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  REPO_MAP_PROMPT_TAG,
  appendToSystemPrompt,
  describeRepoSetChange,
  formatRepoMapPrompt,
  isWriteOutsideRepoSet,
  loadRepoMap,
  parseRepoMap,
  repoForPath,
  serializeRepoMap,
  type RepoSetContext,
} from './repo-set-map'

const ROOT = join(tmpdir(), 'repo-set-map')
const APP = join(ROOT, 'shop-app')
const LIB = join(ROOT, 'shop-lib')
const NESTED = join(APP, 'vendor', 'shop-lib')

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

test('repoForPath maps relative and absolute paths to their checkout, the deepest one first', () => {
  assert.equal(repoForPath(CONTEXT, 'src/index.ts', APP)?.name, 'shop-app')
  assert.equal(repoForPath(CONTEXT, join(LIB, 'api.ts'), APP)?.name, 'shop-lib')
  assert.equal(repoForPath(CONTEXT, '../shop-lib/api.ts', APP)?.name, 'shop-lib')
  assert.equal(repoForPath(CONTEXT, '../shop-lib-secrets/key.pem', APP), null)
  assert.equal(repoForPath(CONTEXT, '../../outside.txt', APP), null)

  const nested: RepoSetContext = {
    ...CONTEXT,
    repos: [...CONTEXT.repos, { name: 'vendored', role: 'linked', workPath: NESTED, branch: null, trusted: false }],
  }
  assert.equal(repoForPath(nested, join(NESTED, 'a.ts'), APP)?.name, 'vendored')
})

test('only a file write outside every checkout counts as leaving the set', () => {
  assert.equal(isWriteOutsideRepoSet(CONTEXT, 'write', { path: '../shop-lib/a.ts' }, APP), false)
  assert.equal(isWriteOutsideRepoSet(CONTEXT, 'edit', { path: join(ROOT, 'other', 'a.ts') }, APP), true)
  assert.equal(isWriteOutsideRepoSet(CONTEXT, 'ast_edit', { path: '/etc/hosts' }, APP), true)
  assert.equal(isWriteOutsideRepoSet(CONTEXT, 'read', { path: '/etc/hosts' }, APP), false)
  assert.equal(isWriteOutsideRepoSet(CONTEXT, 'bash', { command: 'rm -rf /tmp/x' }, APP), false)
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
