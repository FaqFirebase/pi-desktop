import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { engineProjectSessionDirs, findLatestProjectSession } from './latest-project-session'
import { sanitizePath } from './session-paths'

const PROJECT = '/work/demo'
const HEADER = JSON.stringify({ type: 'session', id: 'id', cwd: PROJECT }) + '\n'
const USER_TURN = JSON.stringify({ type: 'message', message: { role: 'user', content: 'hello' } }) + '\n'

async function writeSession(dir: string, name: string, body: string, modifiedSeconds: number): Promise<string> {
  await mkdir(dir, { recursive: true })
  const path = join(dir, name)
  await writeFile(path, body)
  await utimes(path, modifiedSeconds, modifiedSeconds)
  return path
}

async function withBase(fn: (base: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'pi-latest-session-'))
  try {
    await fn(base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

test('the newest used session among the given project directories wins', async () => {
  await withBase(async (base) => {
    const current = join(base, 'current')
    const legacy = join(base, 'legacy')
    await writeSession(current, 'old.jsonl', HEADER + USER_TURN, 1_000)
    const newest = await writeSession(legacy, 'new.jsonl', HEADER + USER_TURN, 3_000)
    await writeSession(current, 'notes.txt', HEADER + USER_TURN, 5_000)

    assert.equal(await findLatestProjectSession([current, legacy]), newest)
  })
})

test('a header-only session is never resumed', async () => {
  await withBase(async (base) => {
    const used = await writeSession(base, 'used.jsonl', HEADER + USER_TURN, 1_000)
    await writeSession(base, 'blank.jsonl', HEADER, 2_000)

    assert.equal(await findLatestProjectSession([base]), used)
  })
})

test('a project without sessions resumes nothing', async () => {
  await withBase(async (base) => {
    assert.equal(await findLatestProjectSession([base, join(base, 'missing')]), null)
  })
})

test('each engine resumes only from its own store, in its own directory naming', async (t) => {
  await withBase(async (base) => {
    t.after(() => {
      delete process.env.PI_CODING_AGENT_DIR
      delete process.env.OMP_CODING_AGENT_DIR
    })
    process.env.PI_CODING_AGENT_DIR = join(base, 'pi')
    process.env.OMP_CODING_AGENT_DIR = join(base, 'omp')
    const project = join(homedir(), 'pi-desktop-resume-test-project')

    assert.deepEqual(await engineProjectSessionDirs('pi', project), [join(base, 'pi', 'sessions', sanitizePath(project))])
    const ompDirs = await engineProjectSessionDirs('omp', project)
    assert.deepEqual(ompDirs, [
      join(base, 'omp', 'sessions', '-pi-desktop-resume-test-project'),
      join(base, 'omp', 'sessions', sanitizePath(project)),
    ])

    // The Pi session is newer, but the selected engine is OMP: its newest session wins.
    await writeSession(join(base, 'pi', 'sessions', sanitizePath(project)), 'pi.jsonl', HEADER + USER_TURN, 9_000)
    const olderOmp = await writeSession(ompDirs[0], 'omp-old.jsonl', HEADER + USER_TURN, 1_000)
    const newerOmp = await writeSession(ompDirs[0], 'omp-new.jsonl', HEADER + USER_TURN, 2_000)
    assert.equal(await findLatestProjectSession(ompDirs), newerOmp)
    assert.notEqual(await findLatestProjectSession(ompDirs), olderOmp)
  })
})
