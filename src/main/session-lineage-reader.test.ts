import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { MAX_PREVIEW_SCAN_BYTES, clearSessionMetadataCache } from './session-metadata'
import { readSessionLineage } from './session-lineage-reader'

// ─── Fixture builders ────────────────────────────────────────────────────────

const headerLine = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: 'session',
    version: 3,
    id: '019f9166-642a-7905-ae5a-f4dbbc6baadb',
    timestamp: '2026-07-23T23:53:54.474Z',
    cwd: '/home/u/proj',
    ...over,
  })

const userLine = (text: string): string =>
  JSON.stringify({
    type: 'message',
    id: 'm1',
    parentId: 'p0',
    timestamp: '2026-07-23T23:54:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text }], timestamp: 1 },
  })

const assistantLine = (text: string): string =>
  JSON.stringify({
    type: 'message',
    id: 'm2',
    parentId: 'm1',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  })

const sessionInfoLine = (name: string): string =>
  JSON.stringify({ type: 'session_info', id: 'i1', parentId: 'm1', name })

interface SessionSpec {
  /** Path relative to the sessions root, e.g. `proj-a/2026-…_aaa.jsonl`. */
  file: string
  lines: string[]
}

async function withSessionStore<T>(
  specs: SessionSpec[],
  fn: (root: string) => Promise<T>,
  extraDirs: string[] = []
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pi-lineage-'))
  try {
    for (const dir of extraDirs) {
      await mkdir(join(root, dir), { recursive: true })
    }
    for (const spec of specs) {
      const full = join(root, spec.file)
      await mkdir(join(full, '..'), { recursive: true })
      await writeFile(full, `${spec.lines.join('\n')}\n`, 'utf-8')
    }
    clearSessionMetadataCache()
    return await fn(root)
  } finally {
    clearSessionMetadataCache()
    await rm(root, { recursive: true, force: true })
  }
}

// ─── The issue #47 regressions ───────────────────────────────────────────────

test('labels a session by its first user message, not its Windows cwd', async () => {
  // Regression: the label was `header.cwd.split('/').pop()`. A win32 cwd has no
  // forward slash, so split returns one element and the whole path was rendered.
  const WIN_CWD = 'C:\\Users\\night\\Downloads\\pi'
  await withSessionStore(
    [
      {
        file: join('proj-a', '2026-07-23T23-53-54-474Z_aaa.jsonl'),
        lines: [headerLine({ cwd: WIN_CWD }), userLine('Refactor auth module login logic')],
      },
    ],
    async (root) => {
      const [record] = await readSessionLineage(root)
      assert.equal(record.preview, 'Refactor auth module login logic')
      assert.notEqual(record.name, WIN_CWD)
      assert.notEqual(record.preview, WIN_CWD)
    }
  )
})

test('does not label POSIX sessions with the shared cwd basename', async () => {
  // Every session in one project dir used to render the identical label.
  await withSessionStore(
    [
      {
        file: join('proj-a', '2026-07-23T23-53-54-474Z_aaa.jsonl'),
        lines: [headerLine({ cwd: '/home/u/pi-desktop-gui' }), userLine('First topic')],
      },
      {
        file: join('proj-a', '2026-07-24T09-00-00-000Z_bbb.jsonl'),
        lines: [headerLine({ cwd: '/home/u/pi-desktop-gui' }), userLine('Second topic')],
      },
    ],
    async (root) => {
      const records = await readSessionLineage(root)
      const previews = records.map((r) => r.preview).sort()
      assert.deepEqual(previews, ['First topic', 'Second topic'])
      assert.ok(!records.some((r) => r.name === 'pi-desktop-gui'))
    }
  )
})

test('prefers an explicit session name over the message preview', async () => {
  await withSessionStore(
    [
      {
        file: join('proj-a', '2026-07-23T23-53-54-474Z_aaa.jsonl'),
        lines: [headerLine(), userLine('Refactor auth'), sessionInfoLine('debug token refresh')],
      },
    ],
    async (root) => {
      const [record] = await readSessionLineage(root)
      assert.equal(record.name, 'debug token refresh')
      assert.equal(record.preview, 'Refactor auth')
    }
  )
})

test('reports no name for an unnamed session', async () => {
  await withSessionStore(
    [
      {
        file: join('proj-a', '2026-07-23T23-53-54-474Z_aaa.jsonl'),
        lines: [headerLine(), userLine('Refactor auth')],
      },
    ],
    async (root) => {
      assert.equal((await readSessionLineage(root))[0].name, null)
    }
  )
})

// ─── Identity and linking ────────────────────────────────────────────────────

test('identifies a session by its filename stem, not the header uuid', async () => {
  // The renderer's title fallback formats the timestamp out of the stem; a bare
  // header uuid would degrade to a 12-char slice instead.
  await withSessionStore(
    [
      {
        file: join('proj-a', '2026-07-23T23-53-54-474Z_aaa.jsonl'),
        lines: [headerLine({ id: 'deadbeef-0000' }), userLine('hi')],
      },
    ],
    async (root) => {
      assert.equal((await readSessionLineage(root))[0].sessionId, '2026-07-23T23-53-54-474Z_aaa')
    }
  )
})

test('links a child to its parent through an absolute parentSession path', async () => {
  // Built without the helper: the child's parentSession must hold the parent's
  // real absolute path, which is only known after the temp root exists.
  const root = await mkdtemp(join(tmpdir(), 'pi-lineage-'))
  try {
    const dir = join(root, 'proj-a')
    await mkdir(dir, { recursive: true })
    const parentPath = join(dir, '2026-07-23T23-53-54-474Z_aaa.jsonl')
    const childPath = join(dir, '2026-07-24T09-00-00-000Z_bbb.jsonl')
    await writeFile(parentPath, `${headerLine()}\n${userLine('parent topic')}\n`, 'utf-8')
    await writeFile(
      childPath,
      `${headerLine({ parentSession: parentPath })}\n${userLine('child topic')}\n`,
      'utf-8'
    )
    clearSessionMetadataCache()

    const records = await readSessionLineage(root)
    const child = records.find((r) => r.preview === 'child topic')!
    const parent = records.find((r) => r.preview === 'parent topic')!
    assert.equal(child.parentPath, parentPath)
    assert.equal(parent.parentPath, null)
    assert.equal(child.path, childPath)
  } finally {
    clearSessionMetadataCache()
    await rm(root, { recursive: true, force: true })
  }
})

// ─── Walk shape ──────────────────────────────────────────────────────────────

test('skips a file whose first line is not a session header', async () => {
  await withSessionStore(
    [
      { file: join('proj-a', 'not-a-session.jsonl'), lines: [userLine('orphan')] },
      {
        file: join('proj-a', '2026-07-23T23-53-54-474Z_aaa.jsonl'),
        lines: [headerLine(), userLine('real session')],
      },
    ],
    async (root) => {
      const records = await readSessionLineage(root)
      assert.equal(records.length, 1)
      assert.equal(records[0].preview, 'real session')
    }
  )
})

test('does not descend into nested subagent directories', async () => {
  // Listing deliberately indexes parent sessions only; lineage must match, or a
  // Timeline mount would flood with ephemeral subagent runs.
  await withSessionStore(
    [
      {
        file: join('proj-a', '2026-07-23T23-53-54-474Z_aaa.jsonl'),
        lines: [headerLine(), userLine('parent session')],
      },
      {
        file: join('proj-a', '2026-07-23T23-53-54-474Z_aaa', 'subagent-run.jsonl'),
        lines: [headerLine({ id: 'nested' }), userLine('subagent run')],
      },
    ],
    async (root) => {
      const records = await readSessionLineage(root)
      assert.equal(records.length, 1)
      assert.equal(records[0].preview, 'parent session')
    }
  )
})

// Contract test, not a guard test: dropping the `isFile()` check is absorbed by
// the reader's error handling (opening a directory throws EISDIR and the record is
// filtered), so this pins the observable behavior rather than the implementation.
test('ignores a directory whose name ends in .jsonl', async () => {
  await withSessionStore(
    [
      {
        file: join('proj-a', '2026-07-23T23-53-54-474Z_aaa.jsonl'),
        lines: [headerLine(), userLine('real session')],
      },
    ],
    async (root) => {
      const records = await readSessionLineage(root)
      assert.equal(records.length, 1)
      assert.equal(records[0].preview, 'real session')
    },
    [join('proj-a', 'trap.jsonl')]
  )
})

test('ignores loose files at the sessions root', async () => {
  await withSessionStore(
    [
      { file: 'stray.jsonl', lines: [headerLine(), userLine('stray')] },
      {
        file: join('proj-a', '2026-07-23T23-53-54-474Z_aaa.jsonl'),
        lines: [headerLine(), userLine('real session')],
      },
    ],
    async (root) => {
      const records = await readSessionLineage(root)
      assert.equal(records.length, 1)
      assert.equal(records[0].preview, 'real session')
    }
  )
})

test('returns no records when the sessions root does not exist', async () => {
  assert.deepEqual(await readSessionLineage('/no/such/sessions/root'), [])
})

test('reads every project directory', async () => {
  await withSessionStore(
    [
      {
        file: join('proj-a', '2026-07-23T23-53-54-474Z_aaa.jsonl'),
        lines: [headerLine(), userLine('from a')],
      },
      {
        file: join('proj-b', '2026-07-24T09-00-00-000Z_bbb.jsonl'),
        lines: [headerLine(), userLine('from b')],
      },
      {
        file: join('proj-c', '2026-07-25T09-00-00-000Z_ccc.jsonl'),
        lines: [headerLine(), userLine('from c')],
      },
    ],
    async (root) => {
      const previews = (await readSessionLineage(root)).map((r) => r.preview).sort()
      assert.deepEqual(previews, ['from a', 'from b', 'from c'])
    }
  )
})

// ─── Bounded I/O ─────────────────────────────────────────────────────────────

test('stays within the scan budget on a session larger than the budget', async () => {
  // The old reader called readFile on the whole file to consume one line. A
  // bounded reader gives up on a message parked past the budget and still
  // returns the header-derived record — an unbounded one would find the message.
  const filler = assistantLine('x'.repeat(64 * 1024))
  const fillerCount = Math.ceil(MAX_PREVIEW_SCAN_BYTES / filler.length) + 2
  await withSessionStore(
    [
      {
        file: join('proj-a', '2026-07-23T23-53-54-474Z_aaa.jsonl'),
        lines: [headerLine(), ...Array.from({ length: fillerCount }, () => filler), userLine('far away')],
      },
    ],
    async (root) => {
      const [record] = await readSessionLineage(root)
      assert.equal(record.sessionId, '2026-07-23T23-53-54-474Z_aaa')
      assert.equal(record.preview, null)
    }
  )
})
