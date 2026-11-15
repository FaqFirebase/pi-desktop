import assert from 'node:assert/strict'
import { test } from 'node:test'
import { COPIED_FEEDBACK_MS, copyThenShowCopied } from './use-copy-feedback'

function recorder(): { shown: boolean[]; delays: number[]; schedule: (run: () => void, ms: number) => void; runScheduled: () => void } {
  const shown: boolean[] = []
  const delays: number[] = []
  const pending: Array<() => void> = []
  return {
    shown,
    delays,
    schedule: (run, ms) => {
      delays.push(ms)
      pending.push(run)
    },
    runScheduled: () => pending.splice(0).forEach((run) => run()),
  }
}

test('Copied shows after the write resolves, then clears after the feedback time', async () => {
  const r = recorder()
  let release: () => void = () => {}
  const written = new Promise<void>((resolve) => { release = resolve })
  const copying = copyThenShowCopied(() => written, (on) => r.shown.push(on), r.schedule)
  await Promise.resolve()
  assert.deepEqual(r.shown, [])
  release()
  assert.equal(await copying, true)
  assert.deepEqual(r.shown, [true])
  assert.deepEqual(r.delays, [COPIED_FEEDBACK_MS])
  r.runScheduled()
  assert.deepEqual(r.shown, [true, false])
})

test('a failed write never shows Copied', async () => {
  const r = recorder()
  assert.equal(await copyThenShowCopied(() => Promise.reject(new Error('denied')), (on) => r.shown.push(on), r.schedule), false)
  assert.deepEqual(r.shown, [])
  assert.deepEqual(r.delays, [])
})
