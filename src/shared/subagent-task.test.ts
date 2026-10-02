import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  appendCapped,
  applyOmpLifecycle,
  applyOmpProgress,
  applyOmpSubagentList,
  applySubagentToolEvent,
  buildInspectCommand,
  countRunningSubagentTasks,
  parseInspectReply,
  parseTranscriptRef,
  replacePiAsyncRuns,
  stripSubagentTasks,
  tasksFromOmpSubagents,
  tasksFromPiAsyncWidget,
  PI_ASYNC_WIDGET_PREFIX,
  PI_INSPECT_WIDGET_PREFIX,
  normalizeSubagentStatus,
  upsertSubagentTask,
  type SubagentTask,
  type SubagentToolEvent,
} from './subagent-task'

function toolEvent(overrides: Partial<SubagentToolEvent>): SubagentToolEvent {
  return {
    source: 'pi-subagents',
    toolCallId: 'call-1',
    args: { agent: 'reviewer', task: 'Review the parser' },
    details: undefined,
    phase: 'start',
    isError: false,
    ...overrides,
  }
}

test('status words from both engines map to four statuses', () => {
  for (const word of ['started', 'pending', 'queued', 'starting', 'running', 'paused', 'detached', 'active']) {
    assert.equal(normalizeSubagentStatus(word), 'running', word)
  }
  for (const word of ['completed', 'complete', 'done']) assert.equal(normalizeSubagentStatus(word), 'done', word)
  for (const word of ['failed', 'error', 'partial', 'rejected']) assert.equal(normalizeSubagentStatus(word), 'failed', word)
  for (const word of ['aborted', 'stopped']) assert.equal(normalizeSubagentStatus(word), 'stopped', word)
  assert.equal(normalizeSubagentStatus('constructor'), null)
  assert.equal(normalizeSubagentStatus(undefined), null)
})

test('upsert replaces a row in place and appends a new one', () => {
  const a: SubagentTask = { id: 'a', source: 'omp', agent: 'scout', label: '', status: 'running', transcriptRef: { kind: 'omp', subagentId: 'a' } }
  const b: SubagentTask = { ...a, id: 'b', transcriptRef: { kind: 'omp', subagentId: 'b' } }
  const both = upsertSubagentTask(upsertSubagentTask([], a), b)
  const updated = upsertSubagentTask(both, { ...a, status: 'done' })
  assert.deepEqual(updated.map((task) => [task.id, task.status]), [['a', 'done'], ['b', 'running']])
  assert.equal(countRunningSubagentTasks(updated), 1)
})

test('a spawn start adds one running row from the tool arguments', () => {
  const tasks = applySubagentToolEvent([], toolEvent({}))
  assert.equal(tasks.length, 1)
  assert.deepEqual(
    { id: tasks[0].id, agent: tasks[0].agent, label: tasks[0].label, status: tasks[0].status, ref: tasks[0].transcriptRef },
    { id: 'call-1', agent: 'reviewer', label: 'Review the parser', status: 'running', ref: { kind: 'pi-foreground' } }
  )
})

test('an update without structured details changes nothing', () => {
  const tasks = applySubagentToolEvent([], toolEvent({}))
  assert.equal(applySubagentToolEvent(tasks, toolEvent({ phase: 'update', details: {} })), tasks)
})

test('foreground progress replaces the argument row with one row per child', () => {
  const started = applySubagentToolEvent([], toolEvent({}))
  const details = {
    mode: 'parallel',
    runId: 'run-1',
    progress: [
      { index: 0, agent: 'reviewer', status: 'running', currentTool: 'read', toolCount: 3, tokens: 1200, durationMs: 4000, recentOutput: ['a', 'b'] },
      { index: 1, agent: 'scout', status: 'completed', toolCount: 5 },
    ],
    results: [],
  }
  const tasks = applySubagentToolEvent(started, toolEvent({ phase: 'update', details }))
  assert.deepEqual(tasks.map((task) => [task.id, task.agent, task.status]), [
    ['call-1:0', 'reviewer', 'running'],
    ['call-1:1', 'scout', 'done'],
  ])
  assert.equal(tasks[0].currentTool, 'read')
  assert.deepEqual(tasks[0].recentOutput, ['a', 'b'])
  assert.equal(tasks[0].toolCallId, 'call-1')
})

test('a foreground end settles running children and records the session file', () => {
  const details = {
    progress: [{ index: 0, agent: 'reviewer', status: 'running' }],
    results: [{ index: 0, agent: 'reviewer', sessionFile: '/home/u/.pi/agent/sessions/p/s/run/run-0/session.jsonl' }],
  }
  const tasks = applySubagentToolEvent([], toolEvent({ phase: 'end', details }))
  assert.equal(tasks[0].status, 'done')
  assert.deepEqual(tasks[0].transcriptRef, { kind: 'pi-foreground', sessionFile: '/home/u/.pi/agent/sessions/p/s/run/run-0/session.jsonl' })
})

test('a spawn call that failed before starting anything leaves no row', () => {
  // A rejected call (bad arguments) reports no runs: nothing ran, so nothing is listed.
  const started = applySubagentToolEvent([], toolEvent({ args: { workflowScript: 'bad' } }))
  assert.equal(started.length, 1)
  assert.deepEqual(applySubagentToolEvent(started, toolEvent({ phase: 'end', args: undefined, details: {}, isError: true })), [])
  assert.deepEqual(applySubagentToolEvent([], toolEvent({ phase: 'end', args: undefined, details: undefined, isError: true })), [])
})

test('a failed run that reported its children keeps them as failed', () => {
  const details = { progress: [{ index: 0, agent: 'reviewer', status: 'running' }], results: [] }
  const tasks = applySubagentToolEvent([], toolEvent({ phase: 'end', details, isError: true }))
  assert.deepEqual(tasks.map((task) => task.status), ['failed'])
})

test('a background launch stays running after the tool returns', () => {
  const details = { mode: 'single', runId: 'r', asyncId: 'async-1', asyncDir: '/tmp/x', results: [] }
  const tasks = applySubagentToolEvent([], toolEvent({ phase: 'end', details }))
  assert.equal(tasks[0].status, 'running')
  assert.deepEqual(tasks[0].transcriptRef, { kind: 'pi-async', asyncId: 'async-1' })
})

test('OMP tool rows have no live view', () => {
  const tasks = applySubagentToolEvent([], toolEvent({ source: 'omp' }))
  assert.deepEqual(tasks[0].transcriptRef, { kind: 'none' })
})

test('rows of one spawn keep their place among other rows', () => {
  let tasks = applySubagentToolEvent([], toolEvent({ toolCallId: 'first' }))
  tasks = applySubagentToolEvent(tasks, toolEvent({ toolCallId: 'second' }))
  tasks = applySubagentToolEvent(tasks, toolEvent({
    toolCallId: 'first', phase: 'update',
    details: { progress: [{ agent: 'a', status: 'running' }, { agent: 'b', status: 'running' }] },
  }))
  assert.deepEqual(tasks.map((task) => task.id), ['first:0', 'first:1', 'second'])
})

// Shapes read from OMP 18.2.6's subagent tracker (`get_subagents`,
// `subagent_lifecycle`, `subagent_progress`).
const LIFECYCLE_STARTED = {
  id: 'PyBridgeReview', index: 0, agent: 'scout', agentSource: 'bundled',
  description: 'Review the Python bridge', status: 'started',
  sessionFile: '/home/u/.omp/agent/sessions/p/s/PyBridgeReview.jsonl', parentToolCallId: 'call-9',
}
const PROGRESS_RUNNING = {
  index: 0, agent: 'scout', agentSource: 'bundled', task: 'long assignment text', parentToolCallId: 'call-9',
  progress: { id: 'PyBridgeReview', status: 'running', currentTool: 'grep', toolCount: 4, tokens: 900, durationMs: 3000 },
}

test('an OMP start adds a running row with an OMP transcript ref', () => {
  const tasks = applyOmpLifecycle([], LIFECYCLE_STARTED)
  assert.deepEqual(tasks, [{
    id: 'PyBridgeReview', source: 'omp', agent: 'scout', label: 'Review the Python bridge', status: 'running',
    transcriptRef: { kind: 'omp', subagentId: 'PyBridgeReview' },
  }])
})

test('OMP progress updates the row and the finish event ends it', () => {
  let tasks = applyOmpLifecycle([], LIFECYCLE_STARTED)
  tasks = applyOmpProgress(tasks, PROGRESS_RUNNING)
  assert.equal(tasks[0].currentTool, 'grep')
  assert.equal(tasks[0].toolCount, 4)
  assert.equal(tasks[0].label, 'Review the Python bridge')
  tasks = applyOmpLifecycle(tasks, { ...LIFECYCLE_STARTED, description: undefined, status: 'completed' })
  assert.equal(tasks[0].status, 'done')
  assert.equal(tasks[0].currentTool, undefined)
  assert.equal(tasks[0].label, 'Review the Python bridge')
  assert.equal(applyOmpLifecycle(tasks, { ...LIFECYCLE_STARTED, status: 'aborted' })[0].status, 'stopped')
})

test('OMP progress for an unseen subagent uses the task text as its label', () => {
  const tasks = applyOmpProgress([], PROGRESS_RUNNING)
  assert.equal(tasks[0].label, 'long assignment text')
})

test('a late OMP progress report never revives a finished row', () => {
  let tasks = applyOmpLifecycle([], LIFECYCLE_STARTED)
  tasks = applyOmpLifecycle(tasks, { ...LIFECYCLE_STARTED, status: 'failed' })
  tasks = applyOmpProgress(tasks, PROGRESS_RUNNING)
  assert.equal(tasks[0].status, 'failed')
})

test('malformed OMP payloads change nothing', () => {
  const tasks = applyOmpLifecycle([], LIFECYCLE_STARTED)
  assert.equal(applyOmpLifecycle(tasks, null), tasks)
  assert.equal(applyOmpLifecycle(tasks, { id: 'x', status: 'unknown-word' }), tasks)
  assert.equal(applyOmpProgress(tasks, { progress: 'nope' }), tasks)
})

test('get_subagents rows seed the list without reviving finished rows', () => {
  const listed = tasksFromOmpSubagents({
    subagents: [
      { id: 'A', index: 0, agent: 'scout', description: 'one', status: 'running', progress: { toolCount: 2 } },
      { id: 'B', index: 1, agent: 'scout', description: 'two', status: 'running' },
      { index: 2 },
    ],
  })
  assert.deepEqual(listed.map((task) => [task.id, task.toolCount]), [['A', 2], ['B', undefined]])
  const finishedB = applyOmpLifecycle(applyOmpLifecycle([], { id: 'B', agent: 'scout', status: 'started' }), { id: 'B', status: 'completed' })
  const fallbackRow = { id: 'call-1', source: 'omp' as const, agent: 'scout', label: '', status: 'running' as const, toolCallId: 'call-1', transcriptRef: { kind: 'none' as const } }
  const merged = applyOmpSubagentList([...finishedB, fallbackRow], listed)
  assert.deepEqual(merged.map((task) => [task.id, task.status]), [['B', 'done'], ['A', 'running']])
  assert.deepEqual(tasksFromOmpSubagents(undefined), [])
})

function asyncWidget(snapshot: unknown): string[] {
  return [`${PI_ASYNC_WIDGET_PREFIX}${JSON.stringify(snapshot)}`]
}

const SNAPSHOT = {
  kind: 'pi-subagents.async-status-snapshot', version: 1, generatedAt: 1,
  caps: {}, omitted: { runs: 0, children: 0, byteLimitExceeded: false },
  runs: [
    {
      id: 'async-1', kind: 'workflow', label: 'review fan-out', state: 'running', startedAt: 1000, updatedAt: 4000,
      children: [
        { id: 'step:0', kind: 'step', label: 'reviewer', state: 'running', startedAt: 1000, updatedAt: 4000, activity: { currentTool: 'read', toolCount: 3 } },
        { id: 'step:1', kind: 'step', label: 'scout', state: 'complete', startedAt: 1000, endedAt: 2500 },
        { id: 'host', kind: 'host-step', label: 'gate', state: 'running' },
      ],
    },
    { id: 'async-2', kind: 'subagent', label: 'oracle', state: 'failed' },
  ],
}

test('the async widget snapshot becomes one row per child run', () => {
  const tasks = tasksFromPiAsyncWidget(asyncWidget(SNAPSHOT))
  assert.ok(tasks)
  assert.deepEqual(tasks.map((task) => [task.id, task.agent, task.status, task.durationMs]), [
    ['async-1:step:0', 'reviewer', 'running', 3000],
    ['async-1:step:1', 'scout', 'done', 1500],
    ['async-2', 'oracle', 'failed', undefined],
  ])
  assert.equal(tasks[0].currentTool, 'read')
  assert.equal(tasks[0].label, 'review fan-out')
  assert.deepEqual(tasks[0].transcriptRef, { kind: 'pi-async', asyncId: 'async-1', childId: 'step:0' })
  assert.deepEqual(tasks[2].transcriptRef, { kind: 'pi-async', asyncId: 'async-2' })
})

test('lines that are not a snapshot are ignored', () => {
  assert.equal(tasksFromPiAsyncWidget(['plain text']), null)
  assert.equal(tasksFromPiAsyncWidget([`${PI_ASYNC_WIDGET_PREFIX}{broken`]), null)
  assert.equal(tasksFromPiAsyncWidget(asyncWidget({ kind: 'other', runs: [] })), null)
  assert.equal(tasksFromPiAsyncWidget(undefined), null)
})

test('a snapshot replaces its runs, drops the launch row, and keeps runs it no longer lists', () => {
  const launch = { id: 'call-1', source: 'pi-subagents' as const, agent: 'reviewer', label: '', status: 'running' as const, toolCallId: 'call-1', transcriptRef: { kind: 'pi-async' as const, asyncId: 'async-1' } }
  const older = { id: 'async-0', source: 'pi-subagents' as const, agent: 'x', label: '', status: 'done' as const, transcriptRef: { kind: 'pi-async' as const, asyncId: 'async-0' } }
  const snapshot = tasksFromPiAsyncWidget(asyncWidget(SNAPSHOT))!
  const merged = replacePiAsyncRuns([older, launch], snapshot)
  assert.deepEqual(merged.map((task) => task.id), ['async-0', 'async-1:step:0', 'async-1:step:1', 'async-2'])
})

function inspectWidget(reply: unknown): string[] {
  return [`${PI_INSPECT_WIDGET_PREFIX}${JSON.stringify(reply)}`]
}

test('an inspect reply is parsed with its request id', () => {
  const reply = parseInspectReply(inspectWidget({
    kind: 'pi-subagents.inspect-reply', version: 1, requestId: 'req-1', asyncId: 'async-1', status: 'complete',
    messages: [
      { role: 'assistant', kind: 'text', text: 'Looking at the parser' },
      { role: 'assistant', kind: 'toolCall', text: 'read src/a.ts', name: 'read' },
      { role: 'toolResult', kind: 'toolResult', text: 'boom', name: 'read', isError: true },
      { role: 'assistant', kind: 'image', text: 'dropped' },
    ],
    finalOutput: 'All good',
  }))
  assert.deepEqual(reply, {
    requestId: 'req-1',
    status: 'done',
    finalOutput: 'All good',
    lines: [
      { role: 'assistant', kind: 'text', text: 'Looking at the parser' },
      { role: 'assistant', kind: 'toolCall', text: 'read src/a.ts', name: 'read' },
      { role: 'toolResult', kind: 'toolResult', text: 'boom', name: 'read', isError: true },
    ],
  })
})

test('an inspect error reply carries its code', () => {
  const reply = parseInspectReply(inspectWidget({ kind: 'pi-subagents.inspect-reply', version: 1, requestId: 'r', error: { code: 'not_found', message: 'gone' } }))
  assert.equal(reply?.errorCode, 'not_found')
  assert.equal(parseInspectReply(inspectWidget({ kind: 'other', requestId: 'r' })), null)
  assert.equal(parseInspectReply(['no prefix']), null)
})

test('the inspect command is built only from whitespace-free ids', () => {
  assert.equal(buildInspectCommand('req-1', { asyncId: 'async-1' }), '/subagents-inspect-rpc req-1 async-1 --lines 200')
  assert.equal(buildInspectCommand('req-1', { asyncId: 'async-1', childId: 'step:0' }), '/subagents-inspect-rpc req-1 async-1 step:0 --lines 200')
  assert.equal(buildInspectCommand('req-1', { asyncId: 'async 1' }), null)
  assert.equal(buildInspectCommand('req-1', { asyncId: 'async-1', childId: 'two words' }), null)
  assert.equal(buildInspectCommand('', { asyncId: 'async-1' }), null)
})

test('transcript refs from the renderer are validated', () => {
  assert.deepEqual(parseTranscriptRef({ kind: 'omp', subagentId: 'A' }), { kind: 'omp', subagentId: 'A' })
  assert.deepEqual(parseTranscriptRef({ kind: 'pi-async', asyncId: 'a', childId: 'c' }), { kind: 'pi-async', asyncId: 'a', childId: 'c' })
  assert.deepEqual(parseTranscriptRef({ kind: 'pi-foreground' }), { kind: 'pi-foreground' })
  assert.deepEqual(parseTranscriptRef({ kind: 'pi-foreground', sessionFile: '/x.jsonl' }), { kind: 'pi-foreground', sessionFile: '/x.jsonl' })
  assert.deepEqual(parseTranscriptRef({ kind: 'none' }), { kind: 'none' })
  assert.equal(parseTranscriptRef({ kind: 'omp' }), null)
  assert.equal(parseTranscriptRef({ kind: 'pi-async', asyncId: 5 }), null)
  assert.equal(parseTranscriptRef('omp'), null)
})

test('appendCapped keeps only the newest items', () => {
  assert.deepEqual(appendCapped([1, 2], [3, 4], 3), [2, 3, 4])
  assert.deepEqual(appendCapped([], [1], 3), [1])
})

test('a management call of the spawn tool adds no row', () => {
  const start = toolEvent({ args: { action: 'status', id: 'async-1' } })
  assert.deepEqual(applySubagentToolEvent([], start), [])
  const appendEnd = toolEvent({ phase: 'end', args: undefined, details: { mode: 'management', results: [], asyncId: 'async-1' } })
  assert.deepEqual(applySubagentToolEvent([], appendEnd), [])
  const started = applySubagentToolEvent([], toolEvent({}))
  assert.deepEqual(applySubagentToolEvent(started, { ...appendEnd, toolCallId: 'call-1' }), [])
})

test('only pi-subagents details make a background transcript ref', () => {
  const details = { asyncId: 'async-1', results: [] }
  const tasks = applySubagentToolEvent([], toolEvent({ source: 'omp', phase: 'end', details }))
  assert.deepEqual(tasks[0].transcriptRef, { kind: 'none' })
})

test('the strip shows running rows and rows spawned since the turn began', () => {
  const old: SubagentTask = { id: 'old', source: 'omp', agent: 's', label: '', status: 'done', transcriptRef: { kind: 'none' } }
  const oldRunning: SubagentTask = { ...old, id: 'old-running', status: 'running' }
  const fresh: SubagentTask = { ...old, id: 'fresh' }
  const known = new Set(['old', 'old-running'])
  assert.deepEqual(stripSubagentTasks([old, oldRunning, fresh], known).map((task) => task.id), ['old-running', 'fresh'])
})
