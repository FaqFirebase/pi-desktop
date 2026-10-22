import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { detectInterruptedTurn, TAIL_WINDOW_BYTES } from './interrupted-turn-reader'

const message = (body: Record<string, unknown>): string =>
  JSON.stringify({ type: 'message', id: `m${Math.random()}`, parentId: 'p', timestamp: 1, message: body })

const assistant = (stopReason: string, content: unknown[]): string =>
  message({ role: 'assistant', stopReason, content })

const toolCall = (id: string): string => assistant('toolUse', [{ type: 'toolCall', id, name: 'bash' }])

const toolResult = (toolCallId: string): string =>
  message({ role: 'toolResult', toolCallId, toolName: 'bash', content: [], isError: false })

const userMessage = (): string => message({ role: 'user', content: [{ type: 'text', text: 'go' }] })

async function withSession(lines: string[], run: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-interrupted-'))
  const path = join(dir, 'session.jsonl')
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8')
  try {
    await run(path)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('a session whose last tool call never returned is interrupted', async () => {
  await withSession([JSON.stringify({ type: 'session', id: 's' }), userMessage(), toolCall('call_1')], async (path) => {
    const check = await detectInterruptedTurn(path)
    assert.equal(check.reason, 'tool-call-unanswered')
  })
})

test('a session that finished cleanly is not interrupted', async () => {
  await withSession([userMessage(), toolCall('call_1'), toolResult('call_1'), assistant('stop', [])], async (path) => {
    const check = await detectInterruptedTurn(path)
    assert.equal(check.reason, null)
  })
})

test('a session the user stopped is not interrupted', async () => {
  await withSession([userMessage(), assistant('aborted', [])], async (path) => {
    const check = await detectInterruptedTurn(path)
    assert.equal(check.reason, null)
  })
})

test('non-message records between the last answer and EOF do not change the verdict', async () => {
  // Renames and custom widgets are appended after the conversation ends.
  await withSession(
    [
      userMessage(),
      toolCall('call_1'),
      JSON.stringify({ type: 'session_info', name: 'a title' }),
      JSON.stringify({ type: 'custom', key: 'x', value: 1 }),
    ],
    async (path) => {
      const check = await detectInterruptedTurn(path)
      assert.equal(check.reason, 'tool-call-unanswered')
    },
  )
})

test('a half-written final line is ignored rather than failing the read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-interrupted-'))
  const path = join(dir, 'session.jsonl')
  await writeFile(path, `${[userMessage(), toolCall('call_1')].join('\n')}\n{"type":"message","mess`, 'utf8')
  try {
    const check = await detectInterruptedTurn(path)
    assert.equal(check.reason, 'tool-call-unanswered')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the window covers a large turn, and reports when it cannot', async () => {
  // A tool result trailing its call by many records stays inside the window, so
  // the verdict is not a false "unanswered" caused by the read boundary.
  const filler: string[] = []
  for (let i = 0; i < 200; i += 1) filler.push(message({ role: 'user', content: [{ type: 'text', text: 'x'.repeat(200) }] }))
  await withSession([toolCall('call_1'), ...filler, toolResult('call_1'), assistant('stop', [])], async (path) => {
    const check = await detectInterruptedTurn(path)
    assert.equal(check.reason, null)
    assert.equal(check.windowTruncated, false)
  })
})

test('a session larger than the window is read from its tail only', async () => {
  // Overwhelmingly large head, verdict at the end: the read must not depend on
  // loading the whole file.
  const big = 'x'.repeat(TAIL_WINDOW_BYTES)
  await withSession(
    [
      userMessage(),
      message({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: big }] }),
      userMessage(),
      toolCall('call_1'),
    ],
    async (path) => {
      const check = await detectInterruptedTurn(path)
      assert.equal(check.reason, 'tool-call-unanswered')
      assert.equal(check.windowTruncated, true)
    },
  )
})

test('a missing or empty session file yields no claim', async () => {
  const missing = await detectInterruptedTurn(join(tmpdir(), 'definitely-not-a-session.jsonl'))
  assert.deepEqual(missing, { reason: null, windowTruncated: false })

  const dir = await mkdtemp(join(tmpdir(), 'pi-interrupted-'))
  try {
    const empty = join(dir, 'empty.jsonl')
    await writeFile(empty, '', 'utf8')
    assert.deepEqual(await detectInterruptedTurn(empty), { reason: null, windowTruncated: false })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
