import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  isModelsConfig,
  parseModelsFile,
  resolveModelsFile,
  serializeModelsFile,
} from './models-file'

test('resolveModelsFile picks Pi models.json', () => {
  const location = resolveModelsFile('pi', '/home/u')
  assert.equal(location.file, join('/home/u', '.pi', 'agent', 'models.json'))
  assert.equal(location.name, 'models.json')
  assert.equal(location.format, 'json')
})

test('resolveModelsFile defaults OMP to models.yml', () => {
  const location = resolveModelsFile('omp', '/nonexistent-home')
  assert.equal(location.file, join('/nonexistent-home', '.omp', 'agent', 'models.yml'))
  assert.equal(location.name, 'models.yml')
  assert.equal(location.format, 'yaml')
})

test('resolveModelsFile prefers an existing OMP models.yaml', async () => {
  const home = await mkdtemp(join(tmpdir(), 'models-file-'))
  try {
    const agentDir = join(home, '.omp', 'agent')
    await mkdir(agentDir, { recursive: true })
    await writeFile(join(agentDir, 'models.yaml'), 'providers: {}\n', 'utf-8')
    const location = resolveModelsFile('omp', home)
    assert.equal(location.name, 'models.yaml')
    assert.equal(location.format, 'yaml')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('parseModelsFile reads YAML and JSON payloads', () => {
  const yamlParsed = parseModelsFile('providers:\n  ollama:\n    baseUrl: http://x\n', 'yaml')
  assert.deepEqual(yamlParsed, { providers: { ollama: { baseUrl: 'http://x' } } })

  const jsonParsed = parseModelsFile('{"providers":{"a":{}}}', 'json')
  assert.deepEqual(jsonParsed, { providers: { a: {} } })

  // Legacy JSON payload left inside a .yml file still parses (YAML superset).
  const legacy = parseModelsFile('{"providers":{"a":{}}}', 'yaml')
  assert.deepEqual(legacy, { providers: { a: {} } })
})

test('parseModelsFile throws on malformed input', () => {
  assert.throws(() => parseModelsFile('{nope', 'json'))
  assert.throws(() => parseModelsFile('a: [unclosed', 'yaml'))
})

test('serializeModelsFile round-trips both formats', () => {
  const config = { providers: { ollama: { baseUrl: 'http://x', models: [{ id: 'm1', name: 'M1' }] } } }
  assert.deepEqual(JSON.parse(serializeModelsFile(config, 'json')), config)
  assert.deepEqual(parseModelsFile(serializeModelsFile(config, 'yaml'), 'yaml'), config)
})

test('isModelsConfig requires a providers object', () => {
  assert.equal(isModelsConfig({ providers: {} }), true)
  assert.equal(isModelsConfig({ providers: { a: {} } }), true)
  assert.equal(isModelsConfig({}), false)
  assert.equal(isModelsConfig({ providers: [] }), false)
  assert.equal(isModelsConfig({ providers: null }), false)
  assert.equal(isModelsConfig(null), false)
  assert.equal(isModelsConfig('providers'), false)
})
