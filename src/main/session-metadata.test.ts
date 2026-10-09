import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  HEAD_SCAN_BYTES,
  MAX_PREVIEW_SCAN_BYTES,
  TAIL_SCAN_BYTES,
  clearSessionMetadataCache,
  inspectSessionContent,
  isContentRecord,
  isUserMessageRecord,
  readFirstUserMessage,
  readSessionMetadata,
  readSessionMetadataCached,
  sessionHeaderFromLine,
  userMessageText,
  type SessionContentState,
} from './session-metadata'

// ─── Fixture builders (mirror the real Pi JSONL record shapes) ────────────────

const SESSION_ID = '019f9166-642a-7905-ae5a-f4dbbc6baadb'

const headerLine = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: 'session',
    version: 3,
    id: SESSION_ID,
    timestamp: '2026-07-23T23:53:54.474Z',
    cwd: '/home/u/proj',
    ...over,
  })

const textBlocks = (...texts: string[]): unknown[] =>
  texts.map((text) => ({ type: 'text', text }))

const messageLine = (role: string, content: unknown): string =>
  JSON.stringify({
    type: 'message',
    id: 'm1',
    parentId: 'p0',
    timestamp: '2026-07-23T23:54:00.000Z',
    message: { role, content, timestamp: 1783505679008 },
  })

const userLine = (content: unknown): string => messageLine('user', content)

/** Extension-injected record that sits ahead of the first user message. */
const customMessageLine = (content: string): string =>
  JSON.stringify({
    type: 'custom_message',
    customType: 'subagent_companion_suggestions',
    content,
    display: true,
  })

const modelChangeLine = (): string =>
  JSON.stringify({ type: 'model_change', id: 'a6', parentId: null, modelId: 'glm-5.2' })

const thinkingLevelChangeLine = (): string =>
  JSON.stringify({ type: 'thinking_level_change', id: 'a7', parentId: 'a6', thinkingLevel: 'medium' })

/** Bookmark on another entry (`/label`, or an extension's setLabel). */
const labelLine = (label: string): string =>
  JSON.stringify({ type: 'label', id: 'l1', parentId: 'a7', targetId: 'a6', label })

/** Extension state (`pi.appendEntry`), which only its extension can interpret. */
const customEntryLine = (): string =>
  JSON.stringify({ type: 'custom', customType: 'plan-mode', id: 'c1', parentId: 'a7', data: { steps: ['Read the code'] } })

const sessionInfoLine = (name: string): string =>
  JSON.stringify({ type: 'session_info', id: 'i1', parentId: 'm1', name })

async function withSessionFile<T>(
  lines: string[],
  fn: (path: string) => Promise<T>
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-session-metadata-'))
  try {
    const path = join(dir, '2026-07-23T23-53-54-474Z_019f9166.jsonl')
    await writeFile(path, lines.length > 0 ? `${lines.join('\n')}\n` : '', 'utf-8')
    clearSessionMetadataCache()
    return await fn(path)
  } finally {
    clearSessionMetadataCache()
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * Both readers must agree: inspectSessionContent gates the close-time delete,
 * and readSessionMetadata's contentState decides which rows the list hides.
 */
async function assertContentState(lines: string[], expected: SessionContentState): Promise<void> {
  await withSessionFile(lines, async (path) => {
    assert.equal(await inspectSessionContent(path), expected, 'inspectSessionContent')
    assert.equal((await readSessionMetadata(path)).contentState, expected, 'readSessionMetadata')
  })
}

// ─── userMessageText ─────────────────────────────────────────────────────────

test('userMessageText joins the text blocks of a user message', () => {
  const record = JSON.parse(userLine(textBlocks('Refactor auth', 'and login')))
  assert.equal(userMessageText(record), 'Refactor auth and login')
})

test('userMessageText accepts content given as a bare string', () => {
  // The session format permits `content: string`; Pi's own reader handles it.
  const record = JSON.parse(userLine('Explain this project structure'))
  assert.equal(userMessageText(record), 'Explain this project structure')
})

test('userMessageText rejects a toolResult that carries text content', () => {
  // toolResult records are `type:"message"` with a text-block content array —
  // structurally identical to a user message. Only `role` separates them, and
  // they outnumber real user messages ~10:1 in a real store.
  const record = JSON.parse(messageLine('toolResult', textBlocks('file contents here')))
  assert.equal(userMessageText(record), null)
})

test('userMessageText rejects an assistant message', () => {
  const record = JSON.parse(messageLine('assistant', textBlocks('Here is the plan')))
  assert.equal(userMessageText(record), null)
})

test('userMessageText rejects a custom_message record', () => {
  const record = JSON.parse(customMessageLine('Try running the tests'))
  assert.equal(userMessageText(record), null)
})

test('userMessageText keeps text blocks and drops image blocks', () => {
  const record = JSON.parse(
    userLine([
      { type: 'text', text: 'describe image' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
    ])
  )
  assert.equal(userMessageText(record), 'describe image')
})

test('userMessageText returns null for a user message with no text', () => {
  const record = JSON.parse(userLine([{ type: 'image', source: { data: 'AAAA' } }]))
  assert.equal(userMessageText(record), null)
})

test('image-only user turns are still classified as real messages', () => {
  const record = JSON.parse(userLine([{ type: 'image', source: { data: 'AAAA' } }]))
  assert.equal(isUserMessageRecord(record), true)
})

test('userMessageText returns null for whitespace-only text', () => {
  const record = JSON.parse(userLine(textBlocks('   \n  ')))
  assert.equal(userMessageText(record), null)
})

test('userMessageText returns null for non-record input', () => {
  assert.equal(userMessageText(null), null)
  assert.equal(userMessageText('a string'), null)
  assert.equal(userMessageText({ type: 'message' }), null)
})

// ─── isContentRecord ─────────────────────────────────────────────────────────

test('isContentRecord does not count the header or metadata entries', () => {
  const metadata = [
    JSON.parse(headerLine()),
    JSON.parse(modelChangeLine()),
    JSON.parse(thinkingLevelChangeLine()),
    JSON.parse(sessionInfoLine('Draft')),
    JSON.parse(labelLine('start')),
    // OMP's first-line title slot, and the record it appends on shutdown.
    { type: 'title', v: 1, title: '' },
    { type: 'custom', customType: 'session_exit', id: 'x1', parentId: 'a6', data: { reason: 'sigterm' } },
  ]
  for (const record of metadata) assert.equal(isContentRecord(record), false, JSON.stringify(record))
})

test('isContentRecord counts every other record, known or not', () => {
  const content = [
    ...['user', 'assistant', 'toolResult', 'bashExecution', 'system'].map((role) =>
      JSON.parse(messageLine(role, textBlocks('text')))
    ),
    JSON.parse(customMessageLine('Subagent run finished')),
    JSON.parse(customEntryLine()),
    { type: 'compaction', id: 'k1', parentId: 'm1', summary: 'Earlier work', firstKeptEntryId: 'm1', tokensBefore: 900 },
    { type: 'branch_summary', id: 'b1', parentId: 'm1', fromId: 'm1', summary: 'Abandoned path' },
    { type: 'usage', id: 'u1', parentId: 'm1', kind: 'cache_warm', provider: 'anthropic', model: 'claude', usage: {} },
    { type: 'future_entry', id: 'f1', parentId: 'm1' },
    {},
    [],
    null,
    'text',
  ]
  for (const record of content) assert.equal(isContentRecord(record), true, JSON.stringify(record))
})

// ─── sessionHeaderFromLine ───────────────────────────────────────────────────

test('sessionHeaderFromLine parses the id, parentSession and cwd', () => {
  const header = sessionHeaderFromLine(
    headerLine({ parentSession: '/home/u/.pi/agent/sessions/proj/parent.jsonl' })
  )
  assert.deepEqual(header, {
    id: SESSION_ID,
    parentSession: '/home/u/.pi/agent/sessions/proj/parent.jsonl',
    cwd: '/home/u/proj',
  })
})

test('sessionHeaderFromLine reports a missing parentSession as null', () => {
  assert.equal(sessionHeaderFromLine(headerLine())?.parentSession, null)
})

test('sessionHeaderFromLine reports a missing cwd as null (legacy headers)', () => {
  const header = JSON.parse(headerLine()) as Record<string, unknown>
  delete header.cwd
  assert.equal(sessionHeaderFromLine(JSON.stringify(header))?.cwd, null)
  assert.equal(sessionHeaderFromLine(headerLine({ cwd: '' }))?.cwd, null)
})

test('sessionHeaderFromLine rejects a line that is not a session header', () => {
  assert.equal(sessionHeaderFromLine(modelChangeLine()), null)
  assert.equal(sessionHeaderFromLine(userLine(textBlocks('hi'))), null)
})

test('sessionHeaderFromLine rejects a header with no id', () => {
  assert.equal(sessionHeaderFromLine(JSON.stringify({ type: 'session', cwd: '/p' })), null)
})

test('sessionHeaderFromLine rejects malformed JSON', () => {
  assert.equal(sessionHeaderFromLine('{"type":"session"'), null)
  assert.equal(sessionHeaderFromLine(''), null)
})

// ─── readFirstUserMessage ────────────────────────────────────────────────────

test('readFirstUserMessage skips the records that precede the first user turn', async () => {
  await withSessionFile(
    [
      headerLine(),
      modelChangeLine(),
      customMessageLine('injected suggestion'),
      messageLine('assistant', textBlocks('unprompted greeting')),
      userLine(textBlocks('Write unit tests for edge cases')),
      userLine(textBlocks('a later message')),
    ],
    async (path) => {
      assert.equal(await readFirstUserMessage(path), 'Write unit tests for edge cases')
    }
  )
})

test('readFirstUserMessage ignores a toolResult that precedes the first user turn', async () => {
  await withSessionFile(
    [
      headerLine(),
      messageLine('toolResult', textBlocks('grep output that looks like prose')),
      userLine(textBlocks('Fix the token refresh')),
    ],
    async (path) => {
      assert.equal(await readFirstUserMessage(path), 'Fix the token refresh')
    }
  )
})

test('readFirstUserMessage skips malformed lines and keeps scanning', async () => {
  await withSessionFile(
    [headerLine(), '{"type":"message", TRUNCATED', '', userLine(textBlocks('Still found me'))],
    async (path) => {
      assert.equal(await readFirstUserMessage(path), 'Still found me')
    }
  )
})

test('readFirstUserMessage returns null when the session has no user turn', async () => {
  await withSessionFile(
    [headerLine(), modelChangeLine(), messageLine('assistant', textBlocks('hello'))],
    async (path) => {
      assert.equal(await readFirstUserMessage(path), null)
    }
  )
})

test('readFirstUserMessage returns null for an empty file', async () => {
  await withSessionFile([], async (path) => {
    assert.equal(await readFirstUserMessage(path), null)
  })
})

test('readFirstUserMessage returns null for a missing file', async () => {
  assert.equal(await readFirstUserMessage('/no/such/session.jsonl'), null)
})

test('readFirstUserMessage recovers a user turn whose line exceeds the head buffer', async () => {
  // Real regression: a session with an inlined base64 image produced a single
  // 643 KB line. The head read sees only a partial line, which must be dropped
  // (never JSON.parsed), so a streaming fallback has to find the message.
  //
  // Must exceed HEAD + TAIL as well as HEAD: a smaller file is read whole in one
  // range, which would find the message directly and never test the fallback.
  const oversizedImage = 'A'.repeat(HEAD_SCAN_BYTES + TAIL_SCAN_BYTES + HEAD_SCAN_BYTES)
  await withSessionFile(
    [
      headerLine(),
      userLine([
        { type: 'text', text: 'describe image' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: oversizedImage } },
      ]),
    ],
    async (path) => {
      assert.equal(await readFirstUserMessage(path), 'describe image')
    }
  )
})

test('readFirstUserMessage gives up at the scan budget instead of reading a huge file', async () => {
  // Filler large enough to push the user turn past the budget. A reader without
  // a budget would find it; the point is that it stops rather than streaming an
  // unbounded file on the Electron main thread.
  const filler = messageLine('assistant', textBlocks('x'.repeat(64 * 1024)))
  const fillerCount = Math.ceil(MAX_PREVIEW_SCAN_BYTES / filler.length) + 2
  await withSessionFile(
    [
      headerLine(),
      ...Array.from({ length: fillerCount }, () => filler),
      userLine(textBlocks('beyond the budget')),
    ],
    async (path) => {
      assert.equal(await readFirstUserMessage(path), null)
    }
  )
})

// ─── readSessionMetadata ─────────────────────────────────────────────────────

test('readSessionMetadata returns the header and a display preview together', async () => {
  await withSessionFile(
    [
      headerLine({ parentSession: '/s/parent.jsonl' }),
      userLine(textBlocks('Refactor auth\nmodule   login logic')),
    ],
    async (path) => {
      const meta = await readSessionMetadata(path)
      assert.equal(meta.header?.id, SESSION_ID)
      assert.equal(meta.header?.parentSession, '/s/parent.jsonl')
      // Newlines and whitespace runs collapse for single-line rendering.
      assert.equal(meta.preview, 'Refactor auth module login logic')
      assert.equal(meta.contentState, 'non-empty')
      // A file this small is read whole, so the fallbacks must not have run.
      assert.equal(meta.name, null)
    }
  )
})

test('readSessionMetadata previews a user turn whose line exceeds the head buffer', async () => {
  const oversizedImage = 'A'.repeat(HEAD_SCAN_BYTES + TAIL_SCAN_BYTES + HEAD_SCAN_BYTES)
  await withSessionFile(
    [
      headerLine(),
      userLine([
        { type: 'text', text: 'describe image' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: oversizedImage } },
      ]),
    ],
    async (path) => {
      const meta = await readSessionMetadata(path)
      assert.equal(meta.header?.id, SESSION_ID)
      assert.equal(meta.preview, 'describe image')
      assert.equal(meta.contentState, 'non-empty')
    }
  )
})

test('readSessionMetadata strips the planning-mode preamble from the preview', async () => {
  const injected = [
    'You are in read-only planning mode.',
    '',
    'Return a step-by-step plan before any implementation.',
    '',
    'User request:',
    'Add a remember-me checkbox',
  ].join('\n')
  await withSessionFile([headerLine(), userLine(textBlocks(injected))], async (path) => {
    const meta = await readSessionMetadata(path)
    assert.equal(meta.preview, 'Add a remember-me checkbox')
    assert.equal(meta.contentState, 'non-empty')
  })
})

test('readSessionMetadata reports a null preview for a header-only session', async () => {
  await withSessionFile([headerLine()], async (path) => {
    const meta = await readSessionMetadata(path)
    assert.equal(meta.header?.id, SESSION_ID)
    assert.equal(meta.preview, null)
    assert.equal(meta.contentState, 'empty')
    assert.equal(await inspectSessionContent(path), 'empty')
  })
})

test('readSessionMetadata returns unknown content for a missing file', async () => {
  const meta = await readSessionMetadata('/no/such/session.jsonl')
  assert.deepEqual(meta, { header: null, name: null, preview: null, contentState: 'unknown' })
})

// ─── Content state (empty is what a tab close may delete) ────────────────────

test('a header with only model, thinking-level, name, and label entries is empty', async () => {
  await assertContentState(
    [headerLine(), modelChangeLine(), thinkingLevelChangeLine(), sessionInfoLine('Draft'), labelLine('start')],
    'empty'
  )
})

test('a custom message with no user turn is content', async () => {
  // pi-subagents `/run` records a run as custom messages and writes no user message.
  await assertContentState([headerLine(), modelChangeLine(), customMessageLine('Subagent run finished')], 'non-empty')
})

test('an assistant answer with no user turn is content', async () => {
  // An extension's sendMessage with triggerTurn starts a turn from a custom
  // message, so the answers that follow have no user message before them.
  await assertContentState(
    [headerLine(), modelChangeLine(), messageLine('assistant', textBlocks('Here is the plan'))],
    'non-empty'
  )
})

test('an extension state entry is content', async () => {
  await assertContentState([headerLine(), modelChangeLine(), customEntryLine()], 'non-empty')
})

test('an entry type the reader does not know is content', async () => {
  await assertContentState(
    [headerLine(), modelChangeLine(), JSON.stringify({ type: 'future_entry', id: 'f1', parentId: 'a6' })],
    'non-empty'
  )
})

test('a malformed line leaves the content unknown', async () => {
  await assertContentState([headerLine(), modelChangeLine(), '{"type":"custom_message", TRUNCATED'], 'unknown')
})

test('content that the head range cuts off is still found', async () => {
  // Larger than head + tail, so readSessionMetadata scans only the head, which
  // ends inside the custom message, and must fall back to the bounded stream.
  const runOutput = 'x'.repeat(HEAD_SCAN_BYTES + TAIL_SCAN_BYTES)
  await assertContentState([headerLine(), modelChangeLine(), customMessageLine(runOutput)], 'non-empty')
})

test('metadata that runs past the scan budget is unknown, never empty', async () => {
  const longLabel = labelLine('x'.repeat(HEAD_SCAN_BYTES))
  const labelCount = Math.ceil(MAX_PREVIEW_SCAN_BYTES / longLabel.length) + 2
  await assertContentState([headerLine(), ...Array.from({ length: labelCount }, () => longLabel)], 'unknown')
})

test('a session with content but no user turn has no preview', async () => {
  // The session list shows such a row. With no name and no preview, the
  // renderer titles it from the timestamp in its file name (getSessionTitle).
  await withSessionFile([headerLine(), customMessageLine('Subagent run finished')], async (path) => {
    const meta = await readSessionMetadata(path)
    assert.equal(meta.header?.id, SESSION_ID)
    assert.equal(meta.name, null)
    assert.equal(meta.preview, null)
    assert.equal(meta.contentState, 'non-empty')
  })
})

// ─── Name resolution (relocated from session-name.test.ts) ───────────────────

test('readSessionMetadata reports no name for an unnamed session', async () => {
  await withSessionFile([headerLine(), userLine(textBlocks('hi'))], async (path) => {
    assert.equal((await readSessionMetadata(path)).name, null)
  })
})

test('readSessionMetadata reads a name from a small session', async () => {
  await withSessionFile(
    [headerLine(), userLine(textBlocks('hi')), sessionInfoLine('Cached name')],
    async (path) => {
      assert.equal((await readSessionMetadata(path)).name, 'Cached name')
    }
  )
})

test('readSessionMetadata treats a cleared name as unnamed', async () => {
  await withSessionFile(
    [headerLine(), sessionInfoLine('Named'), sessionInfoLine('')],
    async (path) => {
      assert.equal((await readSessionMetadata(path)).name, null)
    }
  )
})

test('readSessionMetadata prefers a late rename in the tail over an early title', async () => {
  // Renames append, so the tail outranks the head. Padded past head+tail so both
  // range reads actually run.
  const pad = 'x'.repeat(HEAD_SCAN_BYTES + TAIL_SCAN_BYTES)
  await withSessionFile(
    [
      headerLine(),
      sessionInfoLine('Early title'),
      userLine(textBlocks('Refactor auth')),
      messageLine('assistant', textBlocks(pad)),
      sessionInfoLine('Renamed in tail'),
    ],
    async (path) => {
      const meta = await readSessionMetadata(path)
      assert.equal(meta.name, 'Renamed in tail')
      // The head read still supplies the preview from the same open.
      assert.equal(meta.preview, 'Refactor auth')
    }
  )
})

test('readSessionMetadata keeps the last record of a small file with no trailing newline', async () => {
  // A file under head+tail is read in one range that ends at EOF, so its final
  // line is a whole record. Treating it as a partial fragment would silently drop
  // the most recent rename.
  const dir = await mkdtemp(join(tmpdir(), 'pi-session-metadata-'))
  try {
    const path = join(dir, '2026-07-23T23-53-54-474Z_019f9166.jsonl')
    const lines = [headerLine(), userLine(textBlocks('Refactor auth')), sessionInfoLine('Named last')]
    await writeFile(path, lines.join('\n'), 'utf-8')
    clearSessionMetadataCache()
    const meta = await readSessionMetadata(path)
    assert.equal(meta.name, 'Named last')
    assert.equal(meta.preview, 'Refactor auth')
  } finally {
    clearSessionMetadataCache()
    await rm(dir, { recursive: true, force: true })
  }
})

test('readSessionMetadata keeps a tail rename in a file with no trailing newline', async () => {
  // The tail range ends at EOF, so its final line is a whole record — dropping it
  // as a fragment would lose the most recent rename.
  const pad = 'x'.repeat(HEAD_SCAN_BYTES + TAIL_SCAN_BYTES)
  const dir = await mkdtemp(join(tmpdir(), 'pi-session-metadata-'))
  try {
    const path = join(dir, '2026-07-23T23-53-54-474Z_019f9166.jsonl')
    const lines = [
      headerLine(),
      userLine(textBlocks('Refactor auth')),
      messageLine('assistant', textBlocks(pad)),
      sessionInfoLine('Renamed last'),
    ]
    await writeFile(path, lines.join('\n'), 'utf-8')
    clearSessionMetadataCache()
    assert.equal((await readSessionMetadata(path)).name, 'Renamed last')
  } finally {
    clearSessionMetadataCache()
    await rm(dir, { recursive: true, force: true })
  }
})

test('readSessionMetadata finds a rename buried mid-file behind large output', async () => {
  // Neither head nor tail sees the session_info, so the full-scan fallback runs.
  const pad = 'x'.repeat(HEAD_SCAN_BYTES + TAIL_SCAN_BYTES)
  await withSessionFile(
    [
      headerLine(),
      userLine(textBlocks('Refactor auth')),
      messageLine('assistant', textBlocks(pad)),
      sessionInfoLine('Buried rename'),
      messageLine('assistant', textBlocks(pad)),
    ],
    async (path) => {
      assert.equal((await readSessionMetadata(path)).name, 'Buried rename')
    }
  )
})

// ─── readSessionMetadataCached ───────────────────────────────────────────────

test('readSessionMetadataCached serves the same mtime from cache', async () => {
  await withSessionFile([headerLine(), userLine(textBlocks('First'))], async (path) => {
    const first = await readSessionMetadataCached(path, 1000)
    // Rewrite the file but keep the cache key: a cached read must not re-read.
    await writeFile(path, `${headerLine()}\n${userLine(textBlocks('Second'))}\n`, 'utf-8')
    const second = await readSessionMetadataCached(path, 1000)
    assert.equal(first.preview, 'First')
    assert.equal(second.preview, 'First')
  })
})

test('readSessionMetadataCached re-reads when the mtime changes', async () => {
  await withSessionFile([headerLine(), userLine(textBlocks('First'))], async (path) => {
    assert.equal((await readSessionMetadataCached(path, 1000)).preview, 'First')
    await writeFile(path, `${headerLine()}\n${userLine(textBlocks('Second'))}\n`, 'utf-8')
    assert.equal((await readSessionMetadataCached(path, 2000)).preview, 'Second')
  })
})

// ─── OMP title slot (first-line { type: "title" } record) ────────────────────

const titleLine = (title: string): string =>
  JSON.stringify({ type: 'title', v: 1, title, updatedAt: '2026-08-24T20:05:17.256Z', pad: ' '.repeat(160) })

test('readSessionMetadata falls back to the OMP title slot', async () => {
  await withSessionFile(
    [titleLine('Fix AppImage or run dmg'), headerLine(), userLine(textBlocks('hello'))],
    async (path) => {
      const metadata = await readSessionMetadata(path)
      assert.equal(metadata.name, 'Fix AppImage or run dmg')
      assert.equal(metadata.header?.id, SESSION_ID)
      assert.equal(metadata.preview, 'hello')
    }
  )
})

test('readSessionMetadata treats an empty OMP title slot as unnamed', async () => {
  await withSessionFile(
    [titleLine(''), headerLine(), userLine(textBlocks('hello'))],
    async (path) => {
      assert.equal((await readSessionMetadata(path)).name, null)
    }
  )
})

test('session_info outranks the OMP title slot', async () => {
  await withSessionFile(
    [titleLine('Slot title'), headerLine(), userLine(textBlocks('hi')), sessionInfoLine('Real rename')],
    async (path) => {
      assert.equal((await readSessionMetadata(path)).name, 'Real rename')
    }
  )
})

// ─── OMP content state (OMP 18 record shapes) ────────────────────────────────

/** OMP records the model as one `provider/id` string. */
const ompModelChangeLine = (): string =>
  JSON.stringify({ type: 'model_change', id: 'm0', parentId: null, model: 'opencode-go/deepseek-v4.1-flash' })

/** The record OMP appends to its session file when it shuts down. */
const ompSessionExitLine = (): string =>
  JSON.stringify({ type: 'custom', customType: 'session_exit', id: 'x1', parentId: 'm0', data: { reason: 'sigterm' } })

test('an OMP session that only started and shut down is empty', async () => {
  await assertContentState([titleLine(''), headerLine(), ompModelChangeLine(), ompSessionExitLine()], 'empty')
})

test('an OMP answer with no user turn is content', async () => {
  await assertContentState(
    [titleLine(''), headerLine(), ompModelChangeLine(), messageLine('assistant', textBlocks('done')), ompSessionExitLine()],
    'non-empty'
  )
})
