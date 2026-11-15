import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  chatImportSourceRoot,
  codexSessionIndexPath,
  isImportableSourcePath,
  listImportableChats,
  listSourceFiles,
  readCodexTitles,
  sourceSessionIdFor,
} from './chat-import-sources'

const TIME = '2026-11-14T10:00:00.000Z'
const notImported = async (): Promise<boolean> => false

function jsonl(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n'
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-chat-import-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function writeIn(path: string, content: string): Promise<string> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content, 'utf8')
  return path
}

test('source roots follow the env overrides', () => {
  assert.equal(chatImportSourceRoot('claude-code', { CLAUDE_CONFIG_DIR: '/c' }, '/h'), join('/c', 'projects'))
  assert.equal(chatImportSourceRoot('claude-code', {}, '/h'), join('/h', '.claude', 'projects'))
  assert.equal(chatImportSourceRoot('codex', { CODEX_HOME: '/x' }, '/h'), join('/x', 'sessions'))
  assert.equal(chatImportSourceRoot('codex', {}, '/h'), join('/h', '.codex', 'sessions'))
  assert.equal(codexSessionIndexPath({ CODEX_HOME: '/x' }, '/h'), join('/x', 'session_index.jsonl'))
  assert.equal(codexSessionIndexPath({}, '/h'), join('/h', '.codex', 'session_index.jsonl'))
})

test('isImportableSourcePath rejects paths outside the layout', () => {
  const root = join(tmpdir(), 'root')
  assert.equal(isImportableSourcePath('claude-code', root, join(root, 'p', 'a.jsonl')), true)
  assert.equal(isImportableSourcePath('claude-code', root, join(root, 'p', 'a', 'subagents', 'b.jsonl')), false)
  assert.equal(isImportableSourcePath('claude-code', root, join(root, '..', 'x.jsonl')), false)
  assert.equal(isImportableSourcePath('claude-code', root, join(root, 'p', '..', '..', 'q', 'a.jsonl')), false)
  assert.equal(isImportableSourcePath('claude-code', root, join(root, 'p', 'a.txt')), false)
  assert.equal(isImportableSourcePath('codex', root, join(root, '2026', '11', '14', 'rollout-x.jsonl')), true)
  assert.equal(isImportableSourcePath('codex', root, join(root, '2026', '11', '14', 'other.jsonl')), false)
  assert.equal(isImportableSourcePath('codex', root, join(root, 'rollout-x.jsonl')), false)
})

test('listSourceFiles skips subagent folders', async () => {
  await withTempDir(async (root) => {
    const main = await writeIn(join(root, 'proj', 'a.jsonl'), '{}\n')
    await writeIn(join(root, 'proj', 'a', 'subagents', 'agent-1.jsonl'), '{}\n')
    await writeIn(join(root, 'proj', 'notes.txt'), 'x')
    await writeIn(join(root, 'top.jsonl'), '{}\n')
    assert.deepEqual(await listSourceFiles('claude-code', root), [main])
    assert.deepEqual(await listSourceFiles('claude-code', join(root, 'missing')), [])
  })
  await withTempDir(async (root) => {
    const rollout = await writeIn(join(root, '2026', '11', '14', 'rollout-a.jsonl'), '{}\n')
    await writeIn(join(root, '2026', '11', '14', 'other.jsonl'), '{}\n')
    await writeIn(join(root, '2026', 'rollout-shallow.jsonl'), '{}\n')
    assert.deepEqual(await listSourceFiles('codex', root), [rollout])
  })
})

test('sourceSessionIdFor reads the file name or the Codex meta', async () => {
  await withTempDir(async (root) => {
    const claude = await writeIn(join(root, 'p', 'abc-123.jsonl'), '{}\n')
    assert.equal(await sourceSessionIdFor('claude-code', claude), 'abc-123')
    const codex = await writeIn(join(root, 'rollout-x.jsonl'), jsonl([{ type: 'session_meta', payload: { id: 'cx' } }]))
    assert.equal(await sourceSessionIdFor('codex', codex), 'cx')
    const noMeta = await writeIn(join(root, 'rollout-y.jsonl'), jsonl([{ type: 'response_item', payload: {} }]))
    assert.equal(await sourceSessionIdFor('codex', noMeta), null)
    assert.equal(await sourceSessionIdFor('codex', join(root, 'missing.jsonl')), null)
  })
})

test('listing reads title, cwd and size for Claude Code', async () => {
  await withTempDir(async (root) => {
    const cwd = join(root, 'work')
    await mkdir(cwd)
    const content = jsonl([
      { type: 'user', uuid: 'u', cwd, timestamp: TIME, message: { role: 'user', content: 'hi' } },
      { type: 'ai-title', aiTitle: 'Auto' },
      { type: 'custom-title', customTitle: 'Named' },
    ])
    const present = await writeIn(join(root, 'projects', 'p', 'one.jsonl'), content)
    await writeIn(
      join(root, 'projects', 'p', 'two.jsonl'),
      jsonl([{ type: 'user', uuid: 'u', cwd: join(root, 'gone'), timestamp: TIME, message: { role: 'user', content: 'hi' } }])
    )
    const items = await listImportableChats('claude-code', join(root, 'projects'), notImported, join(root, 'index.jsonl'))
    const one = items.find((item) => item.sourcePath === present)!
    assert.equal(one.title, 'Named')
    assert.equal(one.cwd, cwd)
    assert.equal(one.cwdExists, true)
    assert.equal(one.sourceSessionId, 'one')
    assert.equal(one.sizeBytes, Buffer.byteLength(content))
    assert.equal(one.alreadyImported, false)
    const two = items.find((item) => item.sourceSessionId === 'two')!
    assert.equal(two.cwdExists, false)
    assert.equal(two.title, null)
  })
})

test('listing reads Codex meta and index titles', async () => {
  await withTempDir(async (root) => {
    const indexPath = await writeIn(
      join(root, 'session_index.jsonl'),
      jsonl([{ id: 'cx', thread_name: 'Old' }, { id: 'cx', thread_name: 'Codex chat' }])
    )
    const path = await writeIn(
      join(root, 'sessions', '2026', '11', '14', 'rollout-a.jsonl'),
      jsonl([{ timestamp: TIME, type: 'session_meta', payload: { id: 'cx', cwd: root, timestamp: TIME } }])
    )
    assert.deepEqual([...(await readCodexTitles(indexPath))], [['cx', 'Codex chat']])
    assert.equal((await readCodexTitles(join(root, 'missing.jsonl'))).size, 0)
    const [item] = await listImportableChats('codex', join(root, 'sessions'), notImported, indexPath)
    assert.equal(item.sourcePath, path)
    assert.equal(item.sourceSessionId, 'cx')
    assert.equal(item.title, 'Codex chat')
    assert.equal(item.cwd, root)
    assert.equal(item.cwdExists, true)
  })
})

test('listing marks imported chats and sorts newest first', async () => {
  await withTempDir(async (root) => {
    const record = { type: 'user', uuid: 'u', cwd: root, timestamp: TIME, message: { role: 'user', content: 'hi' } }
    await writeIn(join(root, 'p', 'old.jsonl'), jsonl([record]))
    await new Promise((resolve) => setTimeout(resolve, 20))
    await writeIn(join(root, 'p', 'new.jsonl'), jsonl([record]))
    const items = await listImportableChats('claude-code', root, async (id) => id === 'old', join(root, 'index.jsonl'))
    assert.deepEqual(items.map((item) => [item.sourceSessionId, item.alreadyImported]), [['new', false], ['old', true]])
  })
})

test('listing finds the title in the tail of a large file', async () => {
  await withTempDir(async (root) => {
    const filler = { type: 'progress', data: 'x'.repeat(1000) }
    const records = [
      { type: 'user', uuid: 'u', cwd: root, timestamp: TIME, message: { role: 'user', content: 'hi' } },
      ...Array.from({ length: 400 }, () => filler),
      { type: 'custom-title', customTitle: 'At the end' },
    ]
    await writeIn(join(root, 'p', 'big.jsonl'), jsonl(records))
    const [item] = await listImportableChats('claude-code', root, notImported, join(root, 'index.jsonl'))
    assert.ok(item.sizeBytes > 300 * 1024)
    assert.equal(item.title, 'At the end')
    assert.equal(item.cwd, root)
  })
})
