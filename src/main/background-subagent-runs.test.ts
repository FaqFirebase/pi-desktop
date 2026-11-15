import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PiRpcEvent } from '../shared/ipc-contracts'
import { PI_ASYNC_WIDGET_KEY, PI_ASYNC_WIDGET_PREFIX } from '../shared/subagent-task'
import { createBackgroundSubagentRuns } from './background-subagent-runs'

/** The snapshot kind the async widget carries (private to subagent-task.ts). */
const PI_ASYNC_SNAPSHOT_KIND = 'pi-subagents.async-status-snapshot'

function asyncWidgetEvent(runs: unknown[] | null, widgetKey = PI_ASYNC_WIDGET_KEY): PiRpcEvent {
  const widgetLines = runs
    ? [`${PI_ASYNC_WIDGET_PREFIX}${JSON.stringify({ kind: PI_ASYNC_SNAPSHOT_KIND, version: 1, runs })}`]
    : undefined
  return { type: 'extension_ui_request', id: 'w1', method: 'setWidget', widgetKey, ...(widgetLines ? { widgetLines } : {}) }
}

test('OMP lifecycle events count running runs until they finish', () => {
  const runs = createBackgroundSubagentRuns()
  assert.equal(runs.handleEvent({ type: 'subagent_lifecycle', payload: { id: 't1', status: 'started' } }), true)
  assert.equal(runs.runningCount(), 1)
  assert.equal(runs.handleEvent({ type: 'subagent_lifecycle', payload: { id: 't1', status: 'completed' } }), true)
  assert.equal(runs.runningCount(), 0)
})

test('OMP progress for a new run counts it as running', () => {
  const runs = createBackgroundSubagentRuns()
  assert.equal(runs.handleEvent({ type: 'subagent_progress', payload: { progress: { id: 't2' } } }), true)
  assert.equal(runs.runningCount(), 1)
})

test('the async widget snapshot replaces the earlier one', () => {
  const runs = createBackgroundSubagentRuns()
  assert.equal(runs.handleEvent(asyncWidgetEvent([
    { id: 'async-1', kind: 'subagent', label: 'reviewer', state: 'running' },
    { id: 'async-2', kind: 'subagent', label: 'scout', state: 'running' },
  ])), true)
  assert.equal(runs.runningCount(), 2)

  assert.equal(runs.handleEvent(asyncWidgetEvent([
    { id: 'async-2', kind: 'subagent', label: 'scout', state: 'running' },
  ])), true)
  assert.equal(runs.runningCount(), 1)
})

test('a cleared async widget counts no runs', () => {
  const runs = createBackgroundSubagentRuns()
  runs.handleEvent(asyncWidgetEvent([{ id: 'async-1', kind: 'subagent', label: 'reviewer', state: 'running' }]))
  assert.equal(runs.handleEvent(asyncWidgetEvent(null)), true)
  assert.equal(runs.runningCount(), 0)
})

test('other events and other widgets change nothing', () => {
  const runs = createBackgroundSubagentRuns()
  assert.equal(runs.handleEvent({ type: 'agent_start' }), false)
  assert.equal(runs.handleEvent(asyncWidgetEvent([{ id: 'async-1', kind: 'subagent', state: 'running' }], 'other')), false)
  assert.equal(runs.runningCount(), 0)
})

test('reset clears every run', () => {
  const runs = createBackgroundSubagentRuns()
  runs.handleEvent({ type: 'subagent_lifecycle', payload: { id: 't1', status: 'started' } })
  runs.handleEvent(asyncWidgetEvent([{ id: 'async-1', kind: 'subagent', state: 'running' }]))
  assert.equal(runs.reset(), true)
  assert.equal(runs.runningCount(), 0)
  assert.equal(runs.reset(), false)
})

test('any status but running ends the runs, a restart included', () => {
  for (const status of ['starting', 'stopped', 'error'] as const) {
    const runs = createBackgroundSubagentRuns()
    runs.handleEvent({ type: 'subagent_lifecycle', payload: { id: 't1', status: 'started' } })
    assert.equal(runs.handleStatus(status), true, status)
    assert.equal(runs.runningCount(), 0, status)
  }
})

test('a running status keeps the runs', () => {
  const runs = createBackgroundSubagentRuns()
  runs.handleEvent({ type: 'subagent_lifecycle', payload: { id: 't1', status: 'started' } })
  assert.equal(runs.handleStatus('running'), false)
  assert.equal(runs.runningCount(), 1)
})
