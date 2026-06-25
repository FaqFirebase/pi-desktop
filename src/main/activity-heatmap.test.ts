import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, utimes, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createActivityHeatmapReader } from './activity-heatmap'

// Fixed reference instant so window math is deterministic.
const NOW = new Date('2026-06-25T12:00:00')

function isoOn(day: string): string {
  // Local-noon ISO-ish timestamp for a given YYYY-MM-DD.
  return new Date(`${day}T12:00:00`).toISOString()
}

function messageLine(day: string): string {
  return JSON.stringify({ type: 'message', timestamp: isoOn(day) })
}

function nonMessageLine(day: string): string {
  return JSON.stringify({ type: 'model_change', timestamp: isoOn(day) })
}

async function makeRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'heatmap-'))
}

test('bins message records by local day and ignores non-message records', async () => {
  const root = await makeRoot()
  const dir = join(root, 'ws')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'a.jsonl'),
    [messageLine('2026-06-24'), messageLine('2026-06-24'), nonMessageLine('2026-06-24')].join('\n')
  )

  const reader = createActivityHeatmapReader({ sessionsRoot: root })
  const result = await reader.compute(NOW)

  const day = result.days.find((d) => d.date === '2026-06-24')
  assert.equal(day?.count, 2)
  assert.equal(result.total, 2)
  assert.equal(result.maxCount, 2)
  await rm(root, { recursive: true, force: true })
})

test('pools counts across multiple files and nested dirs', async () => {
  const root = await makeRoot()
  await mkdir(join(root, 'ws1'), { recursive: true })
  await mkdir(join(root, 'ws2/nested'), { recursive: true })
  await writeFile(join(root, 'ws1/a.jsonl'), messageLine('2026-06-20'))
  await writeFile(join(root, 'ws2/nested/b.jsonl'), messageLine('2026-06-20'))

  const reader = createActivityHeatmapReader({ sessionsRoot: root })
  const result = await reader.compute(NOW)

  assert.equal(result.days.find((d) => d.date === '2026-06-20')?.count, 2)
  await rm(root, { recursive: true, force: true })
})

test('returns a zero-filled window of WINDOW_DAYS ending today', async () => {
  const root = await makeRoot()
  const reader = createActivityHeatmapReader({ sessionsRoot: root })
  const result = await reader.compute(NOW)

  assert.equal(result.days.length, 365)
  assert.equal(result.days[result.days.length - 1].date, '2026-06-25')
  assert.equal(result.total, 0)
  assert.equal(result.maxCount, 0)
  await rm(root, { recursive: true, force: true })
})

test('drops days older than the window', async () => {
  const root = await makeRoot()
  await mkdir(join(root, 'ws'), { recursive: true })
  await writeFile(join(root, 'ws/old.jsonl'), messageLine('2024-01-01'))

  const reader = createActivityHeatmapReader({ sessionsRoot: root })
  const result = await reader.compute(NOW)

  assert.equal(result.total, 0)
  await rm(root, { recursive: true, force: true })
})

test('skips malformed lines and unreadable files without throwing', async () => {
  const root = await makeRoot()
  await mkdir(join(root, 'ws'), { recursive: true })
  await writeFile(join(root, 'ws/a.jsonl'), ['not json', '', messageLine('2026-06-22')].join('\n'))

  const reader = createActivityHeatmapReader({ sessionsRoot: root })
  const result = await reader.compute(NOW)

  assert.equal(result.days.find((d) => d.date === '2026-06-22')?.count, 1)
  await rm(root, { recursive: true, force: true })
})

test('reuses cache for unchanged files and re-parses changed files', async () => {
  const root = await makeRoot()
  await mkdir(join(root, 'ws'), { recursive: true })
  const file = join(root, 'ws/a.jsonl')
  await writeFile(file, messageLine('2026-06-21'))

  let reads = 0
  const readFileImpl = async (p: string): Promise<string> => {
    reads += 1
    const { readFile } = await import('fs/promises')
    return readFile(p, 'utf-8')
  }

  const reader = createActivityHeatmapReader({ sessionsRoot: root, readFileImpl })

  await reader.compute(NOW)
  assert.equal(reads, 1)

  // Unchanged file: second compute must not re-read.
  await reader.compute(NOW)
  assert.equal(reads, 1)

  // Change content and bump mtime: must re-read.
  await writeFile(file, [messageLine('2026-06-21'), messageLine('2026-06-21')].join('\n'))
  const future = new Date(Date.now() + 1000)
  await utimes(file, future, future)
  const result = await reader.compute(NOW)
  assert.equal(reads, 2)
  assert.equal(result.days.find((d) => d.date === '2026-06-21')?.count, 2)

  await rm(root, { recursive: true, force: true })
})

test('evicts cache entries for deleted files', async () => {
  const root = await makeRoot()
  await mkdir(join(root, 'ws'), { recursive: true })
  const file = join(root, 'ws/a.jsonl')
  await writeFile(file, messageLine('2026-06-23'))

  const reader = createActivityHeatmapReader({ sessionsRoot: root })
  let result = await reader.compute(NOW)
  assert.equal(result.total, 1)

  await rm(file)
  result = await reader.compute(NOW)
  assert.equal(result.total, 0)

  await rm(root, { recursive: true, force: true })
})
