import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, utimes, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { ActivityStatsStore } from './activity-stats'

// Fixed reference instant so window math is deterministic.
const NOW = new Date('2026-07-05T12:00:00')

function isoOn(day: string, hour = 12): string {
  return new Date(`${day}T${String(hour).padStart(2, '0')}:00:00`).toISOString()
}

interface MsgOpts {
  role?: 'user' | 'assistant'
  model?: string
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  hour?: number
}

function messageLine(day: string, opts: MsgOpts = {}): string {
  const { role = 'user', model, input = 0, output = 0, cacheRead = 0, cacheWrite = 0, hour = 12 } = opts
  const message: Record<string, unknown> = { role }
  if (role === 'assistant' && model) {
    message.model = model
    message.usage = { input, output, cacheRead, cacheWrite }
  }
  return JSON.stringify({ type: 'message', timestamp: isoOn(day, hour), message })
}

async function makeDirs(): Promise<{ root: string; storePath: string }> {
  const base = await mkdtemp(join(tmpdir(), 'stats-'))
  const root = join(base, 'sessions')
  await mkdir(root, { recursive: true })
  return { root, storePath: join(base, 'activity-stats.json') }
}

test('aggregates messages, tokens, models and sessions across files', async () => {
  const { root, storePath } = await makeDirs()
  await mkdir(join(root, 'ws'), { recursive: true })
  await writeFile(
    join(root, 'ws/s1.jsonl'),
    [
      messageLine('2026-07-04', { role: 'user' }),
      messageLine('2026-07-04', { role: 'assistant', model: 'claude-opus-4-8', input: 100, output: 900 }),
    ].join('\n')
  )
  await writeFile(
    join(root, 'ws/s2.jsonl'),
    messageLine('2026-07-05', { role: 'assistant', model: 'claude-sonnet-5', input: 10, output: 40 })
  )

  const store = new ActivityStatsStore({ sessionsRoots: [root], storePath })
  const result = await store.computeStats(NOW)
  const year = result.ranges['365']

  assert.equal(year.messages, 3)
  assert.equal(year.sessions, 2)
  assert.equal(year.totalTokens, 100 + 900 + 10 + 40)
  assert.equal(year.activeDays, 2)
  // Models sorted desc by total; Opus (1000) before Sonnet (50).
  assert.equal(year.models[0].model, 'claude-opus-4-8')
  assert.equal(year.models[0].output, 900)
  assert.equal(year.models[1].model, 'claude-sonnet-5')

  await rm(root, { recursive: true, force: true })
})

test('preserves a session after its file is deleted (captureBeforeDelete)', async () => {
  const { root, storePath } = await makeDirs()
  const file = join(root, 's1.jsonl')
  await writeFile(file, messageLine('2026-07-04', { role: 'assistant', model: 'claude-opus-4-8', input: 5, output: 5 }))

  const store = new ActivityStatsStore({ sessionsRoots: [root], storePath })

  // Capture before delete, with no prior scan, then remove the file.
  store.captureBeforeDelete(file)
  await rm(file)

  const result = await store.computeStats(NOW)
  assert.equal(result.ranges['365'].messages, 1)
  assert.equal(result.ranges['365'].totalTokens, 10)
  assert.equal(result.ranges['365'].sessions, 1)

  await rm(root, { recursive: true, force: true })
})

test('persists across store instances (survives process restart)', async () => {
  const { root, storePath } = await makeDirs()
  const file = join(root, 's1.jsonl')
  await writeFile(file, messageLine('2026-07-03', { role: 'user' }))

  const first = new ActivityStatsStore({ sessionsRoots: [root], storePath })
  first.flushSync(NOW) // synchronous scan + write to disk

  // New instance, and the source file is now gone.
  await rm(file)
  const second = new ActivityStatsStore({ sessionsRoots: [root], storePath })
  const result = await second.computeStats(NOW)
  assert.equal(result.ranges['365'].messages, 1)

  await rm(root, { recursive: true, force: true })
})

test('re-parses a file when its content changes', async () => {
  const { root, storePath } = await makeDirs()
  const file = join(root, 's1.jsonl')
  await writeFile(file, messageLine('2026-07-04', { role: 'user' }))

  const store = new ActivityStatsStore({ sessionsRoots: [root], storePath })
  let result = await store.computeStats(NOW)
  assert.equal(result.ranges['365'].messages, 1)

  await writeFile(
    file,
    [messageLine('2026-07-04', { role: 'user' }), messageLine('2026-07-04', { role: 'user' })].join('\n')
  )
  // Bump mtime so the change is detected even if the rewrite lands in the same
  // filesystem mtime tick (the store re-parses on mtime change).
  const future = new Date(Date.now() + 2000)
  await utimes(file, future, future)
  result = await store.computeStats(NOW)
  assert.equal(result.ranges['365'].messages, 2)

  await rm(root, { recursive: true, force: true })
})

test('range filter: 7d excludes older activity that 1Y includes', async () => {
  const { root, storePath } = await makeDirs()
  await writeFile(join(root, 's1.jsonl'), messageLine('2026-07-04', { role: 'user' })) // in 7d
  await writeFile(join(root, 's2.jsonl'), messageLine('2026-05-01', { role: 'user' })) // outside 7d, inside 1Y

  const store = new ActivityStatsStore({ sessionsRoots: [root], storePath })
  const result = await store.computeStats(NOW)

  assert.equal(result.ranges['365'].messages, 2)
  assert.equal(result.ranges['7'].messages, 1)

  await rm(root, { recursive: true, force: true })
})

test('computes current and longest streaks', async () => {
  const { root, storePath } = await makeDirs()
  // Active Jul 3,4,5 (3-day streak ending today) and an isolated day earlier.
  await writeFile(
    join(root, 's1.jsonl'),
    [
      messageLine('2026-07-03', { role: 'user' }),
      messageLine('2026-07-04', { role: 'user' }),
      messageLine('2026-07-05', { role: 'user' }),
      messageLine('2026-06-20', { role: 'user' }),
    ].join('\n')
  )

  const store = new ActivityStatsStore({ sessionsRoots: [root], storePath })
  const year = (await store.computeStats(NOW)).ranges['365']
  assert.equal(year.currentStreak, 3)
  assert.equal(year.longestStreak, 3)

  await rm(root, { recursive: true, force: true })
})

test('peak hour reflects the busiest local hour', async () => {
  const { root, storePath } = await makeDirs()
  await writeFile(
    join(root, 's1.jsonl'),
    [
      messageLine('2026-07-04', { role: 'user', hour: 9 }),
      messageLine('2026-07-04', { role: 'user', hour: 23 }),
      messageLine('2026-07-04', { role: 'user', hour: 23 }),
    ].join('\n')
  )

  const store = new ActivityStatsStore({ sessionsRoots: [root], storePath })
  const year = (await store.computeStats(NOW)).ranges['365']
  assert.equal(year.peakHour, 23)

  await rm(root, { recursive: true, force: true })
})

test('resolves model names from models.json, keyed by id', async () => {
  const { root, storePath } = await makeDirs()
  const modelsConfigPath = join(root, '..', 'models.json')
  await writeFile(
    modelsConfigPath,
    JSON.stringify({
      providers: {
        lmstudio: { models: [{ id: 'ornith-1.0-35b@q6_k', name: 'Ornith 1.0 Q6' }] },
      },
    })
  )
  await writeFile(
    join(root, 's1.jsonl'),
    [
      messageLine('2026-07-04', { role: 'assistant', model: 'ornith-1.0-35b@q6_k', input: 10, output: 20 }),
      messageLine('2026-07-04', { role: 'assistant', model: 'no-such-model', input: 1, output: 1 }),
    ].join('\n')
  )

  const store = new ActivityStatsStore({ sessionsRoots: [root], storePath, modelsConfigPath })
  const models = (await store.computeStats(NOW)).ranges['365'].models
  const ornith = models.find((m) => m.model === 'ornith-1.0-35b@q6_k')
  const unknown = models.find((m) => m.model === 'no-such-model')
  assert.equal(ornith?.name, 'Ornith 1.0 Q6')
  assert.equal(unknown?.name, null) // not in models.json → null (frontend falls back to id)

  await rm(root, { recursive: true, force: true })
})

test('keeps last-known name after a model is removed from models.json', async () => {
  const { root, storePath } = await makeDirs()
  const modelsConfigPath = join(root, '..', 'models.json')
  await writeFile(join(root, 's1.jsonl'), messageLine('2026-07-04', { role: 'assistant', model: 'm1', input: 5, output: 5 }))

  // First scan with the name present.
  await writeFile(modelsConfigPath, JSON.stringify({ providers: { p: { models: [{ id: 'm1', name: 'Model One' }] } } }))
  const first = new ActivityStatsStore({ sessionsRoots: [root], storePath, modelsConfigPath })
  first.flushSync(NOW)

  // The model disappears from models.json; a fresh instance should still show it.
  await rm(modelsConfigPath)
  const second = new ActivityStatsStore({ sessionsRoots: [root], storePath, modelsConfigPath })
  const models = (await second.computeStats(NOW)).ranges['365'].models
  assert.equal(models.find((m) => m.model === 'm1')?.name, 'Model One')

  await rm(root, { recursive: true, force: true })
})

test('prunes sessions older than the retention window', async () => {
  const { root, storePath } = await makeDirs()
  await writeFile(join(root, 'old.jsonl'), messageLine('2024-01-01', { role: 'user' }))

  const store = new ActivityStatsStore({ sessionsRoots: [root], storePath })
  const result = await store.computeStats(NOW)
  assert.equal(result.ranges['365'].messages, 0)

  await rm(root, { recursive: true, force: true })
})

test('counts cache read and write tokens in the total and per model', async () => {
  const { root, storePath } = await makeDirs()
  await writeFile(
    join(root, 's1.jsonl'),
    messageLine('2026-07-04', { role: 'assistant', model: 'm1', input: 100, output: 20, cacheRead: 1000, cacheWrite: 50 })
  )

  const modelsConfigPath = join(root, '..', 'models.json') // absent: no display names
  const store = new ActivityStatsStore({ sessionsRoots: [root], storePath, modelsConfigPath })
  const result = await store.computeStats(NOW)
  const year = result.ranges['365']

  assert.equal(year.totalTokens, 1170)
  assert.deepEqual(year.models[0], { model: 'm1', name: null, input: 100, output: 20, cacheRead: 1000, cacheWrite: 50 })
  const day = result.days.find((d) => d.date === '2026-07-04')
  assert.equal(day?.tokens, 1170)
  assert.equal(day?.tokensByModel.m1, 1170)

  await rm(root, { recursive: true, force: true })
})

test('counts sessions from every store root', async () => {
  const { root: piRoot, storePath } = await makeDirs()
  const { root: ompRoot } = await makeDirs()
  await writeFile(join(piRoot, 'pi-session.jsonl'), messageLine('2026-07-04', { role: 'assistant', model: 'm1', input: 10, output: 5 }))
  await writeFile(join(ompRoot, 'omp-session.jsonl'), messageLine('2026-07-04', { role: 'assistant', model: 'm2', input: 7, output: 3 }))

  const store = new ActivityStatsStore({ sessionsRoots: [piRoot, ompRoot], storePath })
  const year = (await store.computeStats(NOW)).ranges['365']
  assert.equal(year.sessions, 2)
  assert.equal(year.totalTokens, 25)

  await rm(piRoot, { recursive: true, force: true })
  await rm(ompRoot, { recursive: true, force: true })
})

test('default roots read both the Pi and the OMP store from their env dirs', async () => {
  const { root: piSessions, storePath } = await makeDirs()
  const { root: ompSessions } = await makeDirs()
  await writeFile(join(piSessions, 'pi-session.jsonl'), messageLine('2026-07-04', { role: 'user' }))
  await writeFile(join(ompSessions, 'omp-session.jsonl'), messageLine('2026-07-04', { role: 'user' }))

  const savedPi = process.env.PI_CODING_AGENT_DIR
  const savedOmp = process.env.OMP_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(piSessions, '..')
  process.env.OMP_CODING_AGENT_DIR = join(ompSessions, '..')
  try {
    const store = new ActivityStatsStore({ storePath, modelsConfigPath: join(piSessions, '..', 'models.json') })
    const year = (await store.computeStats(NOW)).ranges['365']
    assert.equal(year.sessions, 2)
    assert.equal(year.messages, 2)
  } finally {
    if (savedPi === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = savedPi
    if (savedOmp === undefined) delete process.env.OMP_CODING_AGENT_DIR
    else process.env.OMP_CODING_AGENT_DIR = savedOmp
  }

  await rm(piSessions, { recursive: true, force: true })
  await rm(ompSessions, { recursive: true, force: true })
})

test('one store listed twice does not double-count its sessions', async () => {
  const { root, storePath } = await makeDirs()
  await writeFile(join(root, 's1.jsonl'), messageLine('2026-07-04', { role: 'assistant', model: 'm1', input: 10, output: 5 }))

  const store = new ActivityStatsStore({ sessionsRoots: [root, root], storePath })
  await store.computeStats(NOW)
  const year = (await store.computeStats(NOW)).ranges['365']
  assert.equal(year.sessions, 1)
  assert.equal(year.totalTokens, 15)

  await rm(root, { recursive: true, force: true })
})

test('a version 1 store re-parses present files and keeps deleted ones', async () => {
  const { root, storePath } = await makeDirs()
  const present = join(root, 'present.jsonl')
  await writeFile(
    present,
    messageLine('2026-07-04', { role: 'assistant', model: 'm1', input: 100, output: 20, cacheRead: 1000, cacheWrite: 50 })
  )
  const { mtimeMs } = await stat(present)
  // Saved by the old store: same mtime as the file, no cache fields.
  const legacyBucket = (input: number, output: number) => ({
    messages: 1,
    models: { m1: { input, output } },
    hours: { '12': 1 },
  })
  await writeFile(
    storePath,
    JSON.stringify({
      version: 1,
      modelNames: {},
      sessions: {
        present: { filePath: present, mtimeMs, days: { '2026-07-04': legacyBucket(100, 20) } },
        deleted: { filePath: join(root, 'deleted.jsonl'), mtimeMs: 1, days: { '2026-07-03': legacyBucket(3, 2) } },
      },
    })
  )

  const store = new ActivityStatsStore({ sessionsRoots: [root], storePath })
  const year = (await store.computeStats(NOW)).ranges['365']
  // Present file re-parsed with cache (1170); deleted session keeps its 5, cache unknown.
  assert.equal(year.sessions, 2)
  assert.equal(year.totalTokens, 1170 + 5)
  assert.equal(year.models[0].cacheRead, 1000)

  await rm(root, { recursive: true, force: true })
})
