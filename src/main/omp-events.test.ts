import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renameOmpEvent } from './omp-events'

test("OMP's manual compaction pair becomes Pi's compaction pair", () => {
  assert.deepEqual(renameOmpEvent({ type: 'manual_compaction_start', mode: 'snapcompact' }), { type: 'compaction_start', reason: 'manual' })
  const result = { summary: 's', firstKeptEntryId: 'e1', tokensBefore: 48210, details: {} }
  assert.deepEqual(
    renameOmpEvent({ type: 'manual_compaction_end', aborted: false, result }),
    { type: 'compaction_end', reason: 'manual', result, aborted: false, willRetry: false },
  )
})

test("a skipped or failed OMP compaction carries Pi's failure wording; an aborted one carries none", () => {
  assert.deepEqual(
    renameOmpEvent({ type: 'manual_compaction_end', aborted: false, skipped: true, errorMessage: 'Already compacted' }),
    { type: 'compaction_end', reason: 'manual', result: undefined, aborted: false, willRetry: false, errorMessage: 'Compaction failed: Already compacted' },
  )
  assert.deepEqual(
    renameOmpEvent({ type: 'manual_compaction_end', aborted: true, errorMessage: 'Compaction cancelled' }),
    { type: 'compaction_end', reason: 'manual', result: undefined, aborted: true, willRetry: false },
  )
})

test('every other event passes through as the same object', () => {
  const piEnd = { type: 'compaction_end', reason: 'manual', result: undefined, aborted: false, willRetry: false, errorMessage: 'Compaction failed: x' }
  assert.equal(renameOmpEvent(piEnd), piEnd)
  const autoEnd = { type: 'auto_compaction_end', reason: 'threshold', aborted: false, willRetry: false }
  assert.equal(renameOmpEvent(autoEnd), autoEnd)
  assert.equal(renameOmpEvent(42), 42)
})
