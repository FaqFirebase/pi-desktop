import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { deriveAutoTag } from './auto-tag'

async function sessionFile(userText: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-autotag-'))
  const path = join(dir, 'session.jsonl')
  const record = {
    type: 'message',
    message: { role: 'user', content: [{ type: 'text', text: userText }] },
  }
  await writeFile(path, JSON.stringify(record) + '\n')
  return path
}

test('intent words win frequency ties', async () => {
  const path = await sessionFile('Please help me refactor the authentication module')
  assert.equal(await deriveAutoTag(path), 'refactor')
})

test('stopwords and short tokens are ignored', async () => {
  const path = await sessionFile('the and for you can use deployment pipeline')
  assert.equal(await deriveAutoTag(path), 'deployment')
})

test('missing file yields null', async () => {
  assert.equal(await deriveAutoTag('/no/such/session.jsonl'), null)
})

test('a session with no user text yields null', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-autotag-'))
  const path = join(dir, 'session.jsonl')
  await writeFile(path, JSON.stringify({ type: 'message', message: { role: 'assistant', content: [] } }) + '\n')
  assert.equal(await deriveAutoTag(path), null)
})
