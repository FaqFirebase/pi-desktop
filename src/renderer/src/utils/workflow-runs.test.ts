import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  canAbortRun,
  canResumeRun,
  filterRunsBySession,
  filterRunsByWorkspace,
  isTerminalRun,
  resolveRunSessionId,
  runActiveAgentCount,
} from './workflow-runs'
import type { WorkflowAgentStatus, WorkflowRunStatus, WorkflowRunSummary } from '../../../shared/ipc-contracts'

const HEADER_UUID = '01a01a28-f010-7b29-8312-21ba523d9edf'
const STEM = `2026-08-19T13-14-45-648Z_${HEADER_UUID}`

function run(sessionId: string | undefined, workspaceId = 'ws'): WorkflowRunSummary {
  return {
    workspaceId,
    workspaceName: 'ws',
    cwd: '/tmp',
    runId: sessionId ?? 'no-session',
    workflowName: 'w',
    sessionId,
    status: 'completed',
    phases: ['plan'],
    startedAt: '2026-08-19T13:00:00.000Z',
    updatedAt: '2026-08-19T13:10:00.000Z',
    agents: [],
  }
}

test('resolveRunSessionId prefers Pi header UUID over the filename stem', () => {
  assert.equal(resolveRunSessionId(HEADER_UUID, STEM), HEADER_UUID)
})

test('resolveRunSessionId derives the UUID from the stem suffix when the header is missing', () => {
  assert.equal(resolveRunSessionId(undefined, STEM), HEADER_UUID)
})

test('resolveRunSessionId never returns the raw stem (tags/archive key)', () => {
  // A stem without the timestamp_ prefix has no derivable UUID.
  assert.equal(resolveRunSessionId(undefined, 'not-a-uuid'), null)
  assert.equal(resolveRunSessionId('', 'not-a-uuid'), null)
})

test('filterRunsBySession keeps only the requested session across different session IDs', () => {
  const otherUuid = '01b2b3c4-d5e6-4f70-a8b9-0c1d2e3f4a5b'
  const runs = [run(HEADER_UUID), run(otherUuid), run(HEADER_UUID), run(undefined)]
  const filtered = filterRunsBySession(runs, HEADER_UUID)
  assert.equal(filtered.length, 2)
  assert.ok(filtered.every((r) => r.sessionId === HEADER_UUID))
})

test('filterRunsBySession with null is the global list', () => {
  const runs = [run(HEADER_UUID), run('01b2b3c4-d5e6-4f70-a8b9-0c1d2e3f4a5b')]
  assert.equal(filterRunsBySession(runs, null).length, 2)
})

test('filterRunsByWorkspace keeps only runs recorded in the requested workspace', () => {
  const runs = [run(HEADER_UUID, 'ws-a'), run(HEADER_UUID, 'ws-b'), run(undefined, 'ws-a')]
  const filtered = filterRunsByWorkspace(runs, 'ws-a')
  assert.equal(filtered.length, 2)
  assert.ok(filtered.every((r) => r.workspaceId === 'ws-a'))
})

test('filterRunsByWorkspace with null is the global list', () => {
  const runs = [run(HEADER_UUID, 'ws-a'), run(HEADER_UUID, 'ws-b')]
  assert.equal(filterRunsByWorkspace(runs, null).length, 2)
})

// ─── Terminal presentation ───────────────────────────────────────────────────

test('isTerminalRun covers the finished statuses only', () => {
  for (const status of ['completed', 'failed', 'aborted'] as WorkflowRunStatus[]) {
    assert.equal(isTerminalRun(status), true, status)
  }
  for (const status of ['pending', 'running', 'paused', 'unknown'] as WorkflowRunStatus[]) {
    assert.equal(isTerminalRun(status), false, status)
  }
})

test('runActiveAgentCount reports zero active agents on terminal runs even with stale running agents', () => {
  const agents = [
    { status: 'running' as WorkflowAgentStatus },
    { status: 'running' as WorkflowAgentStatus },
    { status: 'done' as WorkflowAgentStatus },
  ]
  for (const status of ['completed', 'failed', 'aborted'] as WorkflowRunStatus[]) {
    assert.equal(runActiveAgentCount(agents, status), 0, status)
  }
})

test('runActiveAgentCount counts running agents only while the run is live', () => {
  const agents = [
    { status: 'running' as WorkflowAgentStatus },
    { status: 'running' as WorkflowAgentStatus },
    { status: 'done' as WorkflowAgentStatus },
  ]
  assert.equal(runActiveAgentCount(agents, 'running'), 2)
  assert.equal(runActiveAgentCount(agents, 'paused'), 2)
  assert.equal(runActiveAgentCount(agents, 'pending'), 2)
})

// ─── Control eligibility (mirrors the extension's allowedActions) ───────────

test('canAbortRun is true only for running/paused', () => {
  for (const status of ['running', 'paused'] as WorkflowRunStatus[]) {
    assert.equal(canAbortRun(status), true, status)
  }
  for (const status of ['pending', 'completed', 'failed', 'aborted', 'unknown'] as WorkflowRunStatus[]) {
    assert.equal(canAbortRun(status), false, status)
  }
})

test('canResumeRun is true only for paused/failed/pending — never completed/aborted', () => {
  for (const status of ['paused', 'failed', 'pending'] as WorkflowRunStatus[]) {
    assert.equal(canResumeRun(status), true, status)
  }
  for (const status of ['running', 'completed', 'aborted', 'unknown'] as WorkflowRunStatus[]) {
    assert.equal(canResumeRun(status), false, status)
  }
})
