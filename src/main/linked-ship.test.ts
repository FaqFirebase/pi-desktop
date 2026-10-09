import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { GitConveyorStatus, LinkedShipRequest, LinkedTaskRepo } from '../shared/ipc-contracts'
import {
  LINKED_PULL_REQUESTS_END,
  LINKED_PULL_REQUESTS_START,
  shipLinkedTask,
  shipOrder,
  withLinkedPullRequests,
  type LinkedShipOperations,
} from './linked-ship'
import { readLinkedRepoStatuses } from './linked-task-status'

const BRANCH = 'pi/rename-api-1'

function repo(name: string, role: LinkedTaskRepo['role'] = 'linked'): LinkedTaskRepo {
  return { name, role, sourcePath: `/src/${name}`, repoRoot: `/src/${name}`, workPath: `/wt/${name}`, branch: BRANCH, managed: true }
}

function status(overrides: Partial<GitConveyorStatus> = {}): GitConveyorStatus {
  return {
    branch: BRANCH,
    head: 'abc',
    lastCommitMessage: null,
    dirtyFiles: 0,
    dirtyTrackedFiles: 0,
    ahead: 0,
    behind: 0,
    hasUpstream: false,
    pushRemote: 'origin',
    upstreamBranch: null,
    baseBranch: 'main',
    aheadOfBase: 0,
    remoteUrl: 'git@github.com:o/r.git',
    pullRequestRepo: 'o/r',
    openPullRequest: null,
    ...overrides,
  }
}

const REQUEST: LinkedShipRequest = { message: 'Rename the user API', title: 'Rename user API', body: '## Summary', newFiles: {} }

/**
 * A fake repository per name: `dirty` tracked files to commit, and whether a
 * pull request is open. Each operation moves the fake forward the way git and
 * GitHub would, and records the call.
 */
function fakeOperations(initial: Record<string, { dirty?: number; untracked?: string[]; pr?: string; failAt?: string }>) {
  const calls: string[] = []
  const bodies = new Map<string, string>()
  const state = new Map(Object.entries(initial).map(([name, value]) => [`/wt/${name}`, {
    dirty: value.dirty ?? 0, untracked: value.untracked ?? [], committed: 0, pushed: 0, pr: value.pr ?? null, failAt: value.failAt,
  }]))
  const read = (cwd: string): GitConveyorStatus => {
    const repoState = state.get(cwd)!
    return status({
      dirtyTrackedFiles: repoState.dirty,
      dirtyFiles: repoState.dirty + repoState.untracked.length,
      ahead: repoState.committed - repoState.pushed,
      hasUpstream: repoState.pushed > 0,
      aheadOfBase: repoState.committed,
      openPullRequest: repoState.pr ? { number: 1, url: repoState.pr } : null,
    })
  }
  const failIf = (cwd: string, step: string): void => {
    if (state.get(cwd)!.failAt === step) throw new Error(`${step} failed`)
  }
  const operations: LinkedShipOperations = {
    exists: (path) => state.has(path),
    status: async (cwd) => read(cwd),
    changedPaths: async (cwd) => ({ tracked: ['src/api.ts', 'old.ts'], untracked: state.get(cwd)!.untracked }),
    commit: async (cwd, options) => {
      calls.push(`commit ${cwd} ${JSON.stringify(options)}`)
      failIf(cwd, 'commit')
      const repoState = state.get(cwd)!
      repoState.dirty = 0
      repoState.committed += 1
      return read(cwd)
    },
    push: async (cwd) => {
      calls.push(`push ${cwd}`)
      failIf(cwd, 'push')
      state.get(cwd)!.pushed = state.get(cwd)!.committed
      return read(cwd)
    },
    createPullRequest: async (cwd, options) => {
      calls.push(`pr ${cwd} ${options.title}`)
      failIf(cwd, 'pullRequest')
      const url = `https://github.com/o${cwd.replace('/wt', '')}/pull/1`
      state.get(cwd)!.pr = url
      return { url, output: url }
    },
    readPullRequestBody: async (_cwd, url) => bodies.get(url) ?? '## Summary',
    updatePullRequestBody: async (cwd, url, body) => {
      calls.push(`link ${url}`)
      failIf(cwd, 'link')
      bodies.set(url, body)
    },
  }
  return { operations, calls, bodies, state }
}

test('shipOrder puts linked repositories first, in set order, and the main one last', () => {
  assert.deepEqual(shipOrder([repo('app', 'main'), repo('lib'), repo('docs')]).map((item) => item.name), ['lib', 'docs', 'app'])
})

test('withLinkedPullRequests replaces its own section and keeps the rest of the description', () => {
  const links = [{ name: 'lib', url: 'https://github.com/o/lib/pull/1' }]
  const once = withLinkedPullRequests('## Summary\nText', links)
  assert.equal(once, `## Summary\nText\n\n${LINKED_PULL_REQUESTS_START}\n### Linked pull requests\n- lib: https://github.com/o/lib/pull/1\n${LINKED_PULL_REQUESTS_END}`)
  const twice = withLinkedPullRequests(once, [...links, { name: 'docs', url: 'https://github.com/o/docs/pull/2' }])
  assert.equal(twice.split(LINKED_PULL_REQUESTS_START).length, 2, 'one section only')
  assert.match(twice, /- docs: https:\/\/github\.com\/o\/docs\/pull\/2/)
  assert.equal(withLinkedPullRequests(once, []), '## Summary\nText')
  assert.equal(withLinkedPullRequests('', links).startsWith(LINKED_PULL_REQUESTS_START), true)
})

test('ship all commits, pushes, and opens a pull request per changed repository, then cross-links them', async () => {
  const { operations, calls, bodies } = fakeOperations({ app: { dirty: 2 }, lib: { dirty: 1 }, docs: {} })
  const result = await shipLinkedTask([repo('app', 'main'), repo('lib'), repo('docs')], REQUEST, operations)

  assert.deepEqual(result.repos.map((item) => [item.name, item.outcome]), [['lib', 'shipped'], ['docs', 'unchanged'], ['app', 'shipped']])
  assert.deepEqual(calls.filter((call) => !call.startsWith('link')), [
    `commit /wt/lib ${JSON.stringify({ message: REQUEST.message })}`,
    'push /wt/lib',
    'pr /wt/lib Rename user API',
    `commit /wt/app ${JSON.stringify({ message: REQUEST.message })}`,
    'push /wt/app',
    'pr /wt/app Rename user API',
  ])
  const appBody = bodies.get('https://github.com/o/app/pull/1') ?? ''
  assert.match(appBody, /- lib: https:\/\/github\.com\/o\/lib\/pull\/1/)
  assert.doesNotMatch(appBody, /- app:/, 'a pull request never links to itself')
})

test('checked new files are committed with every tracked path, both sides of a rename included', async () => {
  const { operations, calls } = fakeOperations({ app: { dirty: 1, untracked: ['new.ts', 'scratch.log'] }, lib: {} })
  await shipLinkedTask([repo('app', 'main'), repo('lib')], { ...REQUEST, newFiles: { app: ['new.ts'] } }, operations)
  assert.equal(calls[0], `commit /wt/app ${JSON.stringify({ message: REQUEST.message, paths: ['src/api.ts', 'old.ts', 'new.ts'], newFiles: ['new.ts'] })}`)
})

test('a failure stops only its own repository, and a retry resumes at the failed step', async () => {
  const fake = fakeOperations({ app: { dirty: 1 }, lib: { dirty: 1, failAt: 'push' } })
  const first = await shipLinkedTask([repo('app', 'main'), repo('lib')], REQUEST, fake.operations)
  assert.deepEqual(first.repos.map((item) => [item.name, item.outcome, item.failedStep]), [
    ['lib', 'failed', 'push'], ['app', 'shipped', undefined],
  ])
  assert.equal(first.repos[0].error, 'push failed')
  assert.equal(fake.calls.some((call) => call.startsWith('link')), false, 'one pull request has nothing to link')

  fake.state.get('/wt/lib')!.failAt = undefined
  fake.calls.length = 0
  const retry = await shipLinkedTask([repo('app', 'main'), repo('lib')], { ...REQUEST, repos: ['lib'] }, fake.operations)
  assert.deepEqual(retry.repos.map((item) => [item.name, item.outcome]), [['lib', 'shipped']])
  assert.deepEqual(fake.calls.filter((call) => !call.startsWith('link')), ['push /wt/lib', 'pr /wt/lib Rename user API'])
  // The retry made the second pull request, so both descriptions now link.
  assert.match(fake.bodies.get('https://github.com/o/app/pull/1') ?? '', /- lib:/)
  assert.match(fake.bodies.get('https://github.com/o/lib/pull/1') ?? '', /- app:/)
})

test('a missing checkout is reported, and a linking failure marks only that repository', async () => {
  const { operations } = fakeOperations({ app: { dirty: 1 }, lib: { dirty: 1, failAt: 'link' } })
  const result = await shipLinkedTask([repo('app', 'main'), repo('lib'), repo('gone')], REQUEST, operations)
  assert.deepEqual(result.repos.map((item) => [item.name, item.outcome, item.failedStep]), [
    ['lib', 'failed', 'link'], ['gone', 'missing', undefined], ['app', 'shipped', undefined],
  ])
  assert.equal(result.repos[0].pullRequestUrl, 'https://github.com/o/lib/pull/1')
})

test('changes on the base branch are refused before anything is committed', async () => {
  const { operations, calls } = fakeOperations({ app: { dirty: 1 } })
  operations.status = async () => status({ branch: 'main', dirtyTrackedFiles: 1 })
  const result = await shipLinkedTask([repo('app', 'main')], REQUEST, operations)
  assert.equal(result.repos[0].outcome, 'failed')
  assert.equal(result.repos[0].failedStep, 'commit')
  assert.deepEqual(calls, [])
})

test('a repository whose remote is not on GitHub fails at the pull request step', async () => {
  const { operations } = fakeOperations({ app: { dirty: 1 } })
  const read = operations.status
  operations.status = async (cwd) => ({ ...(await read(cwd)), pullRequestRepo: null })
  operations.commit = async () => status({ ahead: 1, aheadOfBase: 1, pullRequestRepo: null })
  operations.push = async () => status({ hasUpstream: true, aheadOfBase: 1, pullRequestRepo: null })
  const result = await shipLinkedTask([repo('app', 'main')], REQUEST, operations)
  assert.equal(result.repos[0].failedStep, 'pullRequest')
})

test('repo bar rows report changes, new files, and pull requests, and survive a missing or broken checkout', async () => {
  const { operations } = fakeOperations({ app: { dirty: 2, untracked: ['new.ts'], pr: 'https://github.com/o/app/pull/9' }, lib: {} })
  const broken = { ...operations, status: async (cwd: string) => cwd === '/wt/lib' ? Promise.reject(new Error('git')) : operations.status(cwd) }
  const rows = await readLinkedRepoStatuses([repo('app', 'main'), repo('lib'), repo('gone')], 'lib', broken)
  assert.deepEqual(rows.map((row) => [row.name, row.exists, row.focused, row.changedFiles, row.newFiles, row.pullRequestUrl]), [
    ['app', true, false, 3, ['new.ts'], 'https://github.com/o/app/pull/9'],
    ['lib', true, true, 0, [], null],
    ['gone', false, false, 0, [], null],
  ])
})

test('with no remote base, an unchanged worktree is not pushed, and a committed one is', async () => {
  const pushed: string[] = []
  const unknownBase = (head: string, overrides: Partial<GitConveyorStatus> = {}): GitConveyorStatus =>
    status({ head, aheadOfBase: null, baseBranch: null, ...overrides })
  const operations: LinkedShipOperations = {
    ...fakeOperations({}).operations,
    exists: () => true,
    status: async (cwd) => cwd === '/wt/lib' ? unknownBase('start', { dirtyTrackedFiles: 1 }) : unknownBase('start'),
    commit: async () => unknownBase('next', { ahead: 0 }),
    push: async (cwd) => {
      pushed.push(cwd)
      throw new Error('no remote')
    },
  }
  const base = { ...repo('app', 'main'), baseRef: 'start' }
  const lib = { ...repo('lib'), baseRef: 'start' }
  const result = await shipLinkedTask([base, lib], REQUEST, operations)
  assert.deepEqual(result.repos.map((item) => [item.name, item.outcome, item.failedStep]), [
    ['lib', 'failed', 'push'], ['app', 'unchanged', undefined],
  ])
  assert.deepEqual(pushed, ['/wt/lib'])
})

test('a retry with the same checked new files does not commit them again', async () => {
  const fake = fakeOperations({ app: { untracked: ['VERSION'] }, lib: {} })
  const commitNewFile = fake.operations.commit
  fake.operations.commit = async (cwd, options) => {
    const next = await commitNewFile(cwd, options)
    fake.state.get(cwd)!.untracked = []
    return next
  }
  fake.state.get('/wt/app')!.failAt = 'push'
  const request = { ...REQUEST, newFiles: { app: ['VERSION'] } }
  const first = await shipLinkedTask([repo('app', 'main'), repo('lib')], request, fake.operations)
  assert.equal(first.repos.find((item) => item.name === 'app')?.failedStep, 'push')

  fake.state.get('/wt/app')!.failAt = undefined
  fake.calls.length = 0
  const retry = await shipLinkedTask([repo('app', 'main'), repo('lib')], { ...request, repos: ['app'] }, fake.operations)
  assert.deepEqual(retry.repos.map((item) => [item.name, item.outcome]), [['app', 'shipped']])
  assert.equal(fake.calls.some((call) => call.startsWith('commit')), false, 'the committed file is not committed again')
})

test('with no remote base, changes on main or master are refused too', async () => {
  for (const branch of ['main', 'master']) {
    const { operations, calls } = fakeOperations({ app: { dirty: 1 } })
    operations.status = async () => status({ branch, baseBranch: null, aheadOfBase: null, dirtyTrackedFiles: 1 })
    const result = await shipLinkedTask([{ ...repo('app', 'main'), managed: false }], REQUEST, operations)
    assert.equal(result.repos[0].failedStep, 'commit', branch)
    assert.deepEqual(calls, [])
  }
})
