import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readdir, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { JSON_FILE_INDENT, TEMP_FILE_SUFFIX, uniqueTempPath, writeJsonFileAtomic } from './atomic-file-write'

const FILE_NAME = 'data.json'
const WRITE_COUNT = 20

test('writeJsonFileAtomic creates the folder and writes indented JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-atomic-'))
  const path = join(dir, 'nested', FILE_NAME)
  await writeJsonFileAtomic(path, { a: 1 })
  assert.equal(await readFile(path, 'utf8'), JSON.stringify({ a: 1 }, null, JSON_FILE_INDENT))
})

test('concurrent writes leave one whole file and no temp files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-atomic-'))
  const path = join(dir, FILE_NAME)
  await Promise.all(Array.from({ length: WRITE_COUNT }, (_, value) => writeJsonFileAtomic(path, { value })))
  const parsed = JSON.parse(await readFile(path, 'utf8')) as { value: number }
  assert.equal(typeof parsed.value, 'number')
  assert.deepEqual(await readdir(dir), [FILE_NAME])
})

test('each temp path is unique and ends with the temp suffix', () => {
  const first = uniqueTempPath('/d/f.json')
  assert.notEqual(first, uniqueTempPath('/d/f.json'))
  assert.equal(first.startsWith('/d/f.json.'), true)
  assert.equal(first.endsWith(TEMP_FILE_SUFFIX), true)
})
