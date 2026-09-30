import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CommitMessageGenerationError, CommitMessageService, type CommitMessageGenerator } from './commit-message-service'
import type { CommitDiffSnapshot } from './git-conveyor'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function setup() {
  const snapshots = new Map<string, CommitDiffSnapshot | null>()
  const service = new CommitMessageService({
    resolvePath: async (cwd) => cwd === '/alias' ? '/repo' : cwd,
    readDiff: async (cwd) => snapshots.get(cwd) ?? null,
  })
  const setDiff = (fingerprint: string, diff = fingerprint, cwd = '/repo') => {
    snapshots.set(cwd, { fingerprint, diff })
  }
  return { service, setDiff }
}

function counting(answer: (diff: string, call: number) => Promise<string>) {
  const diffs: string[] = []
  const generate: CommitMessageGenerator = async (diff) => {
    diffs.push(diff)
    return answer(diff, diffs.length)
  }
  return { generate, diffs }
}

test('a suggestion describes the current commit diff', async () => {
  const { service, setDiff } = setup()
  setDiff('both', 'first and second changes')
  const { generate, diffs } = counting(async (diff) => `fix: ${diff}`)
  assert.deepEqual(await service.suggest('/repo', generate), { message: 'fix: first and second changes', error: null })
  assert.deepEqual(diffs, ['first and second changes'])
})

test('a clean tree has nothing to describe and never calls the model', async () => {
  const { service } = setup()
  const { generate, diffs } = counting(async () => 'unused')
  assert.deepEqual(await service.suggest('/repo', generate), { message: null, error: null })
  assert.deepEqual(diffs, [])
})

test('reopening with an unchanged diff reuses the suggestion; a changed diff generates again', async () => {
  const { service, setDiff } = setup()
  const { generate, diffs } = counting(async (diff) => `fix: ${diff}`)
  setDiff('one')
  await service.suggest('/repo', generate)
  assert.equal((await service.suggest('/repo', generate)).message, 'fix: one')
  setDiff('two')
  assert.equal((await service.suggest('/repo', generate)).message, 'fix: two')
  assert.deepEqual(diffs, ['one', 'two'])
})

test('regenerate replaces a finished suggestion for the same diff', async () => {
  const { service, setDiff } = setup()
  const { generate } = counting(async (_diff, call) => `fix: attempt ${call}`)
  setDiff('same')
  assert.equal((await service.suggest('/repo', generate)).message, 'fix: attempt 1')
  assert.equal((await service.suggest('/repo', generate, true)).message, 'fix: attempt 2')
})

test('workspaces sharing a physical path reuse a suggestion but worktrees do not', async () => {
  const { service, setDiff } = setup()
  const { generate, diffs } = counting(async (diff) => `fix: ${diff}`)
  setDiff('shared')
  setDiff('worktree', 'worktree', '/worktree')
  await service.suggest('/repo', generate)
  await service.suggest('/alias', generate)
  await service.suggest('/worktree', generate)
  assert.deepEqual(diffs, ['shared', 'worktree'])
})

test('concurrent and regenerate requests share an in-flight attempt instead of duplicating it', async () => {
  const { service, setDiff } = setup()
  const pending = deferred<string>()
  const { generate, diffs } = counting(() => pending.promise)
  setDiff('same')
  const first = service.suggest('/repo', generate)
  const second = service.suggest('/repo', generate, true)
  await new Promise((resolve) => setImmediate(resolve))
  pending.resolve('fix: shared')
  assert.deepEqual(await Promise.all([first, second]), [
    { message: 'fix: shared', error: null }, { message: 'fix: shared', error: null },
  ])
  assert.equal(diffs.length, 1)
})

test('a newer diff aborts the older generation', async () => {
  const { service, setDiff } = setup()
  const signals: AbortSignal[] = []
  const generate: CommitMessageGenerator = (diff, signal) => {
    signals.push(signal)
    return diff === 'old' ? new Promise(() => {}) : Promise.resolve(`fix: ${diff}`)
  }
  setDiff('old')
  void service.suggest('/repo', generate)
  await new Promise((resolve) => setImmediate(resolve))
  setDiff('new')
  assert.equal((await service.suggest('/repo', generate)).message, 'fix: new')
  assert.equal(signals[0].aborted, true)
})

test('failures are typed data, are not cached, and the next request can recover', async () => {
  const { service, setDiff } = setup()
  const { generate } = counting(async (_diff, call) => {
    if (call === 1) throw new Error('provider said: secret prompt text')
    if (call === 2) throw new CommitMessageGenerationError('timed-out', 'timed out')
    return 'fix: recovered'
  })
  setDiff('same')
  assert.deepEqual(await service.suggest('/repo', generate), { message: null, error: 'generation-failed' })
  assert.deepEqual(await service.suggest('/repo', generate), { message: null, error: 'timed-out' })
  assert.deepEqual(await service.suggest('/repo', generate), { message: 'fix: recovered', error: null })
})

test('shutdown cancels pending work', async () => {
  const { service, setDiff } = setup()
  let signal: AbortSignal | undefined
  setDiff('same')
  void service.suggest('/repo', (_diff, next) => {
    signal = next
    return new Promise(() => {})
  })
  await new Promise((resolve) => setImmediate(resolve))
  service.dispose()
  assert.equal(signal?.aborted, true)
})

