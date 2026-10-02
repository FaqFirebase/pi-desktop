import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialTranscriptState, MAX_FETCHES_AFTER_END, reduceTranscript, transcriptPollMs, transcriptStatusUpdate, type TranscriptView } from './subagent-transcript-view'
import { OMP_TRANSCRIPT_POLL_MS, PI_INSPECT_POLL_MS } from '../../shared/subagent-task'

const OMP_REF = { kind: 'omp' as const, subagentId: 'A' }

function assistant(text: string): unknown {
  return { role: 'assistant', content: [{ type: 'text', text }] }
}

test('the start state follows the ref kind', () => {
  assert.equal(initialTranscriptState(OMP_REF, true).view.kind, 'loading')
  assert.equal(initialTranscriptState({ kind: 'none' }, true).view.kind, 'unavailable')
  assert.equal(initialTranscriptState({ kind: 'pi-foreground' }, true).view.kind, 'progress')
  assert.equal(initialTranscriptState({ kind: 'pi-foreground', sessionFile: '/s.jsonl' }, false).view.kind, 'loading')
  // A finished foreground run with no session file has nothing more to show.
  assert.equal(initialTranscriptState({ kind: 'pi-foreground' }, false).view.kind, 'unavailable')
})

test('OMP pages append and a reset starts over', () => {
  let state = reduceTranscript(initialTranscriptState(OMP_REF, true), { kind: 'messages', messages: [assistant('one')], nextCursor: 100, reset: false }, true)
  state = reduceTranscript(state, { kind: 'messages', messages: [assistant('two')], nextCursor: 200, reset: false }, true)
  assert.equal(state.cursor, 200)
  assert.equal(state.view.kind, 'messages')
  if (state.view.kind === 'messages') assert.deepEqual(state.view.messages.map((m) => m.content), ['one', 'two'])
  state = reduceTranscript(state, { kind: 'messages', messages: [assistant('fresh')], nextCursor: 50, reset: true }, true)
  if (state.view.kind === 'messages') assert.deepEqual(state.view.messages.map((m) => m.content), ['fresh'])
})

test('a failed refresh keeps the content and flags it; a later success clears the flag', () => {
  let state = reduceTranscript(initialTranscriptState(OMP_REF, true), { kind: 'messages', messages: [assistant('one')], nextCursor: 10, reset: false }, true)
  state = reduceTranscript(state, { kind: 'error', code: 'timeout' }, true)
  assert.equal(state.view.kind === 'messages' && state.view.refreshFailed, true)
  state = reduceTranscript(state, { kind: 'messages', messages: [], nextCursor: 10, reset: false }, true)
  assert.equal(state.view.kind === 'messages' && state.view.refreshFailed, false)
})

test('with no content yet, a gone run is unavailable and a passing failure keeps loading', () => {
  const start = initialTranscriptState({ kind: 'pi-async', asyncId: 'a' }, true)
  assert.equal(reduceTranscript(start, { kind: 'error', code: 'not-found' }, true).view.kind, 'unavailable')
  assert.equal(reduceTranscript(start, { kind: 'error', code: 'timeout' }, true).view.kind, 'loading')
  assert.equal(reduceTranscript(start, { kind: 'error', code: 'timeout' }, false).view.kind, 'unavailable')
})

test('inspect lines replace the view each time', () => {
  const start = initialTranscriptState({ kind: 'pi-async', asyncId: 'a' }, true)
  const state = reduceTranscript(start, { kind: 'lines', lines: [{ role: 'assistant', kind: 'text', text: 'hi' }], finalOutput: 'end' }, false)
  assert.deepEqual(state.view, { kind: 'lines', lines: [{ role: 'assistant', kind: 'text', text: 'hi' }], finalOutput: 'end', refreshFailed: false })
})

const LOADING: TranscriptView = { kind: 'loading' }
const LINES_NO_FINAL: TranscriptView = { kind: 'lines', lines: [], refreshFailed: false }
const LINES_FINAL: TranscriptView = { kind: 'lines', lines: [], finalOutput: 'done', refreshFailed: false }

test('polling runs only for live OMP and background Pi rows', () => {
  assert.equal(transcriptPollMs(OMP_REF, true, LOADING, 0), OMP_TRANSCRIPT_POLL_MS)
  assert.equal(transcriptPollMs({ kind: 'pi-async', asyncId: 'a' }, true, LOADING, 0), PI_INSPECT_POLL_MS)
  assert.equal(transcriptPollMs(OMP_REF, false, LOADING, 0), null)
  assert.equal(transcriptPollMs({ kind: 'pi-foreground', sessionFile: '/s' }, true, LOADING, 0), null)
  assert.equal(transcriptPollMs({ kind: 'none' }, true, LOADING, 0), null)
})

test('a finished background Pi row is fetched again until its final output arrives, a few times at most', () => {
  const ref = { kind: 'pi-async' as const, asyncId: 'a', childId: 'step:0' }
  // The extension writes the final output a moment after the row turns done.
  assert.equal(transcriptPollMs(ref, false, LINES_NO_FINAL, 0), PI_INSPECT_POLL_MS)
  assert.equal(transcriptPollMs(ref, false, LINES_NO_FINAL, MAX_FETCHES_AFTER_END), null)
  assert.equal(transcriptPollMs(ref, false, LINES_FINAL, 0), null)
})

test('an inspect status updates only a run-level row, never a step child', () => {
  const lines = { kind: 'lines' as const, lines: [], status: 'running' as const }
  assert.equal(transcriptStatusUpdate({ kind: 'pi-async', asyncId: 'a' }, lines), 'running')
  // The extension reports the whole run's state for a step child.
  assert.equal(transcriptStatusUpdate({ kind: 'pi-async', asyncId: 'a', childId: 'step:0' }, lines), null)
  assert.equal(transcriptStatusUpdate(OMP_REF, lines), null)
  assert.equal(transcriptStatusUpdate({ kind: 'pi-async', asyncId: 'a' }, { kind: 'lines', lines: [] }), null)
})
