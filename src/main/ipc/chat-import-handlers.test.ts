import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_IMPORT_PATHS_PER_RUN, parseChatImportListRequest, parseChatImportRequest } from './chat-import-handlers'

test('list request accepts a source and an optional engine', () => {
  assert.deepEqual(parseChatImportListRequest({ source: 'codex' }), { source: 'codex' })
  assert.deepEqual(parseChatImportListRequest({ source: 'claude-code', engine: 'omp' }), { source: 'claude-code', engine: 'omp' })
})

test('list request rejects an unknown source', () => {
  assert.throws(() => parseChatImportListRequest({ source: 'other' }))
  assert.throws(() => parseChatImportListRequest(null))
  assert.throws(() => parseChatImportListRequest({ source: 'codex', engine: 'other' }))
})

const VALID = { source: 'claude-code', engine: 'pi', sourcePaths: ['/a.jsonl'] }

test('import request rejects an empty path list', () => {
  assert.throws(() => parseChatImportRequest({ ...VALID, sourcePaths: [] }))
  assert.throws(() => parseChatImportRequest({ ...VALID, sourcePaths: 'x' }))
})

test('import request rejects more than 1000 paths', () => {
  assert.equal(MAX_IMPORT_PATHS_PER_RUN, 1000)
  const paths = Array.from({ length: MAX_IMPORT_PATHS_PER_RUN + 1 }, (_, index) => `/c${index}.jsonl`)
  assert.throws(() => parseChatImportRequest({ ...VALID, sourcePaths: paths }))
  assert.equal(parseChatImportRequest({ ...VALID, sourcePaths: paths.slice(1) }).sourcePaths.length, MAX_IMPORT_PATHS_PER_RUN)
})

test('import request rejects a non-string path', () => {
  assert.throws(() => parseChatImportRequest({ ...VALID, sourcePaths: ['/a.jsonl', 5] }))
})

test('import request rejects an unknown engine or source', () => {
  assert.throws(() => parseChatImportRequest({ ...VALID, engine: 'other' }))
  assert.throws(() => parseChatImportRequest({ ...VALID, engine: undefined }))
  assert.throws(() => parseChatImportRequest({ ...VALID, source: 'other' }))
})

test('import request keeps paths in order', () => {
  assert.deepEqual(parseChatImportRequest({ ...VALID, sourcePaths: ['/b.jsonl', '/a.jsonl'] }), {
    source: 'claude-code',
    engine: 'pi',
    sourcePaths: ['/b.jsonl', '/a.jsonl'],
  })
})
