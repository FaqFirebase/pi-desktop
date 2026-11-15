import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AgentEngineKind } from '../shared/ipc-contracts'
import type { ChatImportProgress, ChatImportResult, ChatImportSource } from '../shared/chat-import'
import { ChatImportIndex } from './chat-import-index'
import { runChatImport } from './chat-import-runner'
import { OMP_TITLE_SLOT_BYTES } from './chat-import-writer'
import { engineProjectSessionDirs } from './latest-project-session'
import { readSessionEntries } from './session-jsonl'
import { readSessionMetadata } from './session-metadata'
import { sanitizePath } from './session-paths'

const TIME = '2026-11-14T10:00:00.000Z'
const MAX_SESSION_BYTES = 64 * 1024 * 1024
const ENV_KEYS = ['PI_CODING_AGENT_DIR', 'OMP_CODING_AGENT_DIR', 'OMP_PROFILE', 'PI_PROFILE', 'PI_DESKTOP_USER_DATA_DIR'] as const

interface Sandbox {
  base: string
  piRoot: string
  ompRoot: string
  claudeRoot: string
  codexRoot: string
  codexIndex: string
  cwd: string
  realCwd: string
  index: ChatImportIndex
}

async function withSandbox(run: (sandbox: Sandbox) => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  const base = await mkdtemp(join(tmpdir(), 'pi-chat-import-'))
  try {
    process.env.PI_CODING_AGENT_DIR = join(base, 'pi-agent')
    process.env.OMP_CODING_AGENT_DIR = join(base, 'omp-agent')
    process.env.PI_DESKTOP_USER_DATA_DIR = join(base, 'gui')
    delete process.env.OMP_PROFILE
    delete process.env.PI_PROFILE
    const realCwd = join(base, 'work')
    await mkdir(realCwd)
    const cwd = join(base, 'work-link')
    await symlink(realCwd, cwd)
    await run({
      base,
      piRoot: join(base, 'pi-agent', 'sessions'),
      ompRoot: join(base, 'omp-agent', 'sessions'),
      claudeRoot: join(base, 'claude', 'projects'),
      codexRoot: join(base, 'codex', 'sessions'),
      codexIndex: join(base, 'codex', 'session_index.jsonl'),
      cwd,
      realCwd: await realpath(realCwd),
      index: new ChatImportIndex(join(base, 'gui', 'chat-imports.json')),
    })
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    await rm(base, { recursive: true, force: true })
  }
}

function jsonl(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n'
}

async function writeSource(path: string, records: unknown[]): Promise<string> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, jsonl(records), 'utf8')
  return path
}

function claudeCodeChat(cwd: string): unknown[] {
  const base = { isSidechain: false, sessionId: 'chat-1', cwd, timestamp: TIME }
  return [
    { type: 'user', uuid: 'u1', parentUuid: null, ...base, message: { role: 'user', content: 'hello there' } },
    {
      type: 'assistant',
      uuid: 'a1',
      parentUuid: 'u1',
      ...base,
      message: { id: 'm1', role: 'assistant', model: 'm', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }] },
    },
    { type: 'user', uuid: 'r1', parentUuid: 'a1', ...base, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.txt' }] } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'r1', ...base, message: { id: 'm2', role: 'assistant', model: 'm', content: [{ type: 'text', text: 'one file' }] } },
    { type: 'custom-title', customTitle: 'Imported chat', sessionId: 'chat-1' },
  ]
}

async function claudeCodeSource(sandbox: Sandbox, id = 'chat-1', cwd = sandbox.cwd): Promise<string> {
  return writeSource(join(sandbox.claudeRoot, sanitizePath(cwd), `${id}.jsonl`), claudeCodeChat(cwd))
}

async function run(
  sandbox: Sandbox,
  source: ChatImportSource,
  engine: AgentEngineKind,
  sourcePaths: string[],
  onProgress: (progress: ChatImportProgress) => void = () => {},
): Promise<ChatImportResult> {
  return runChatImport({
    request: { source, engine, sourcePaths },
    sourceRoot: source === 'claude-code' ? sandbox.claudeRoot : sandbox.codexRoot,
    codexIndexPath: sandbox.codexIndex,
    index: sandbox.index,
    onProgress,
  })
}

async function filesUnder(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name)
  } catch {
    return []
  }
}

/** Parsed session records, read loosely by the assertions (JSON.parse's own result type). */
type Row = Record<string, ReturnType<typeof JSON.parse>>

function assertChained(entries: Row[]): void {
  const records = entries.filter((entry) => entry.type !== 'session' && entry.type !== 'title')
  records.forEach((entry, index) => assert.equal(entry.parentId, index === 0 ? null : records[index - 1].id))
}

function toolPair(entries: Row[]): { call: Row; result: Row } {
  const messages = entries.filter((entry) => entry.type === 'message').map((entry) => entry.message)
  const callIndex = messages.findIndex((message) => message.content.some((block: Row) => block.type === 'toolCall'))
  return { call: messages[callIndex].content.find((block: Row) => block.type === 'toolCall'), result: messages[callIndex + 1] }
}

test("Claude Code import round-trips through the app's readers (Pi)", async () => {
  await withSandbox(async (sandbox) => {
    const source = await claudeCodeSource(sandbox)
    const result = await run(sandbox, 'claude-code', 'pi', [source])
    assert.equal(result.imported.length, 1)
    assert.deepEqual([result.skipped, result.failed], [[], []])
    const [{ sessionPath, title }] = result.imported
    assert.equal(title, 'Imported chat')
    assert.equal(dirname(sessionPath), join(sandbox.piRoot, sanitizePath(sandbox.realCwd)))

    const metadata = await readSessionMetadata(sessionPath)
    assert.equal(metadata.header?.cwd, sandbox.realCwd)
    assert.equal(metadata.name, 'Imported chat')
    assert.equal(metadata.preview, 'hello there')
    assert.equal(metadata.contentState, 'non-empty')

    const entries = (await readSessionEntries(sessionPath, MAX_SESSION_BYTES)) as Row[]
    assert.equal(entries[0].type, 'session')
    assertChained(entries)
    const { call, result: toolResult } = toolPair(entries)
    assert.equal(call.name, 'bash')
    assert.equal(toolResult.role, 'toolResult')
    assert.equal(toolResult.toolCallId, call.id)
    assert.deepEqual(await filesUnder(sandbox.ompRoot), [])
  })
})

test('runner writes OMP imports into the directory OMP reads', async () => {
  await withSandbox(async (sandbox) => {
    const source = await claudeCodeSource(sandbox)
    const result = await run(sandbox, 'claude-code', 'omp', [source])
    assert.equal(result.imported.length, 1)
    const { sessionPath } = result.imported[0]
    assert.equal(dirname(sessionPath), (await engineProjectSessionDirs('omp', sandbox.realCwd))[0])
    const firstLine = (await readFile(sessionPath, 'utf8')).split('\n')[0]
    assert.equal(Buffer.byteLength(firstLine + '\n'), OMP_TITLE_SLOT_BYTES)
    const metadata = await readSessionMetadata(sessionPath)
    assert.equal(metadata.name, 'Imported chat')
    assert.equal(metadata.header?.cwd, sandbox.realCwd)
    assertChained((await readSessionEntries(sessionPath, MAX_SESSION_BYTES)) as Row[])
  })
})

test('Codex import round-trips (Pi)', async () => {
  await withSandbox(async (sandbox) => {
    await writeSource(sandbox.codexIndex, [{ id: 'cx-1', thread_name: 'Codex chat' }])
    const item = (payload: Record<string, unknown>): Record<string, unknown> => ({ timestamp: TIME, type: 'response_item', payload })
    const source = await writeSource(join(sandbox.codexRoot, '2026', '11', '14', 'rollout-2026-11-14T10-00-00-cx-1.jsonl'), [
      { timestamp: TIME, type: 'session_meta', payload: { id: 'cx-1', cwd: sandbox.cwd, timestamp: TIME } },
      item({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'rules' }] }),
      item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list files' }] }),
      item({ type: 'reasoning', summary: [], encrypted_content: 'x' }),
      item({ type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'ls'] }), call_id: 'call_1' }),
      item({ type: 'function_call_output', call_id: 'call_1', output: '{"output":"a.txt","metadata":{"exit_code":0}}' }),
      item({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'one file' }] }),
    ])
    const result = await run(sandbox, 'codex', 'pi', [source])
    assert.equal(result.imported.length, 1)
    assert.equal(result.imported[0].title, 'Codex chat')
    const entries = (await readSessionEntries(result.imported[0].sessionPath, MAX_SESSION_BYTES)) as Row[]
    const { call, result: toolResult } = toolPair(entries)
    assert.deepEqual([call.name, call.arguments], ['bash', { command: 'ls' }])
    assert.equal(toolResult.toolCallId, call.id)
    assert.equal(toolResult.content[0].text, 'a.txt')
    assert.equal((await readSessionMetadata(result.imported[0].sessionPath)).preview, 'list files')
  })
})

test('the same chat imports once per engine', async () => {
  await withSandbox(async (sandbox) => {
    const source = await claudeCodeSource(sandbox)
    assert.equal((await run(sandbox, 'claude-code', 'pi', [source])).imported.length, 1)
    const again = await run(sandbox, 'claude-code', 'pi', [source])
    assert.deepEqual(again.skipped, [{ sourcePath: source, title: null }])
    assert.equal(again.imported.length, 0)
    assert.equal((await run(sandbox, 'claude-code', 'omp', [source])).imported.length, 1)
  })
})

test('a removed import can be imported again', async () => {
  await withSandbox(async (sandbox) => {
    const source = await claudeCodeSource(sandbox)
    const first = await run(sandbox, 'claude-code', 'pi', [source])
    await rm(first.imported[0].sessionPath)
    assert.equal((await run(sandbox, 'claude-code', 'pi', [source])).imported.length, 1)
  })
})

test('missing folder fails without writing', async () => {
  await withSandbox(async (sandbox) => {
    const source = await claudeCodeSource(sandbox, 'chat-1', join(sandbox.base, 'gone'))
    const result = await run(sandbox, 'claude-code', 'pi', [source])
    assert.deepEqual(result.failed, [{ sourcePath: source, title: 'Imported chat', code: 'folder-missing' }])
    assert.deepEqual(await filesUnder(sandbox.piRoot), [])
  })
})

test('a chat with no messages fails without writing', async () => {
  await withSandbox(async (sandbox) => {
    const source = await writeSource(join(sandbox.claudeRoot, 'p', 'empty.jsonl'), [
      { type: 'user', uuid: 'm', parentUuid: null, isMeta: true, cwd: sandbox.cwd, timestamp: TIME, message: { role: 'user', content: 'meta' } },
      { type: 'last-prompt', lastPrompt: 'x' },
      { type: 'file-history-snapshot', snapshot: {} },
    ])
    const result = await run(sandbox, 'claude-code', 'pi', [source])
    assert.deepEqual(result.failed.map((failure) => failure.code), ['no-messages'])
    assert.deepEqual(await filesUnder(sandbox.piRoot), [])
  })
})

test('paths outside the source layout fail', async () => {
  await withSandbox(async (sandbox) => {
    const outside = await writeSource(join(sandbox.base, 'elsewhere', 'chat.jsonl'), claudeCodeChat(sandbox.cwd))
    const subagent = await writeSource(join(sandbox.claudeRoot, 'p', 'chat', 'subagents', 'agent.jsonl'), claudeCodeChat(sandbox.cwd))
    const result = await run(sandbox, 'claude-code', 'pi', [outside, subagent])
    assert.deepEqual(result.failed.map((failure) => failure.code), ['invalid-path', 'invalid-path'])
  })
})

test('a session that cannot be written fails and leaves no temp file', async () => {
  await withSandbox(async (sandbox) => {
    const source = await claudeCodeSource(sandbox)
    // A file where the project folder of the store should be.
    await mkdir(sandbox.piRoot, { recursive: true })
    await writeFile(join(sandbox.piRoot, sanitizePath(sandbox.realCwd)), 'x')
    const result = await run(sandbox, 'claude-code', 'pi', [source])
    assert.deepEqual(result.failed.map((failure) => failure.code), ['write-failed'])
    assert.deepEqual(await filesUnder(sandbox.piRoot), [sanitizePath(sandbox.realCwd)])
    assert.equal(await sandbox.index.importedPath('pi:claude-code:chat-1'), null)
  })
})

test('unreadable Codex files fail', async () => {
  await withSandbox(async (sandbox) => {
    const source = await writeSource(join(sandbox.codexRoot, '2026', '11', '14', 'rollout-x.jsonl'), [{ type: 'response_item', payload: {} }])
    const result = await run(sandbox, 'codex', 'pi', [source])
    assert.deepEqual(result.failed.map((failure) => failure.code), ['unreadable'])
  })
})

test('source files are not changed', async () => {
  await withSandbox(async (sandbox) => {
    const source = await claudeCodeSource(sandbox)
    const hash = async (): Promise<string> => createHash('sha256').update(await readFile(source)).digest('hex')
    const [beforeHash, beforeStat] = [await hash(), await stat(source)]
    await run(sandbox, 'claude-code', 'pi', [source])
    const afterStat = await stat(source)
    assert.equal(await hash(), beforeHash)
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs)
    assert.equal(afterStat.size, beforeStat.size)
    assert.deepEqual(await readdir(dirname(source)), ['chat-1.jsonl'])
  })
})

test('progress counts files', async () => {
  await withSandbox(async (sandbox) => {
    const first = await claudeCodeSource(sandbox, 'chat-1')
    const second = await claudeCodeSource(sandbox, 'chat-2')
    const events: ChatImportProgress[] = []
    await run(sandbox, 'claude-code', 'pi', [first, second], (progress) => events.push(progress))
    assert.deepEqual(events.at(-1), { done: 2, total: 2, currentTitle: null })
    assert.deepEqual(events[0], { done: 0, total: 2, currentTitle: null })
    events.forEach((event, index) => assert.ok(index === 0 || event.done >= events[index - 1].done))
    assert.ok(events.some((event) => event.currentTitle === 'Imported chat'))
  })
})

test('runner streams and yields on a large synthetic file', async () => {
  await withSandbox(async (sandbox) => {
    const base = { isSidechain: false, sessionId: 'big', cwd: sandbox.cwd, timestamp: TIME }
    const records: unknown[] = []
    let parent: string | null = null
    for (let index = 0; index < 20000; index++) {
      const uuid = `n${index}`
      records.push(
        index % 2 === 0
          ? { type: 'user', uuid, parentUuid: parent, ...base, message: { role: 'user', content: `question ${index}` } }
          : { type: 'assistant', uuid, parentUuid: parent, ...base, message: { id: uuid, role: 'assistant', model: 'm', content: [{ type: 'text', text: `answer ${index}` }] } }
      )
      parent = uuid
    }
    const source = await writeSource(join(sandbox.claudeRoot, 'p', 'big.jsonl'), records)
    let ticks = 0
    const timer = setInterval(() => ticks++, 0)
    try {
      const result = await run(sandbox, 'claude-code', 'pi', [source])
      assert.equal(result.imported.length, 1)
      assert.ok(ticks > 0)
      const entries = (await readSessionEntries(result.imported[0].sessionPath, MAX_SESSION_BYTES)) as Row[]
      assert.equal(entries.filter((entry) => entry.type === 'message').length, 20000)
    } finally {
      clearInterval(timer)
    }
  })
})
