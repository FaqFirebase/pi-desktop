import assert from 'node:assert/strict'
import { test } from 'node:test'
import { summarizeBackgroundActivity, workspaceActivityIndicator } from './sidebar-activity'
import type { WorkspaceActivityMap } from '../../../shared/ipc-contracts'

test('workspaceActivityIndicator maps each state, skipping needs-approval', () => {
  assert.equal(workspaceActivityIndicator(undefined), null)
  assert.equal(workspaceActivityIndicator({ state: 'needs-approval', since: 1 }), null)

  const working = workspaceActivityIndicator({ state: 'working', since: 1 })
  assert.equal(working?.pulse, true)
  assert.equal(working?.colorClass, 'bg-accent')

  const completed = workspaceActivityIndicator({ state: 'completed', since: 1 })
  assert.equal(completed?.pulse, false)
  assert.equal(completed?.colorClass, 'bg-success')

  const failed = workspaceActivityIndicator({ state: 'failed', since: 1 })
  assert.equal(failed?.colorClass, 'bg-error')
})

test('summarizeBackgroundActivity ignores the active workspace', () => {
  const map: WorkspaceActivityMap = { 'ws-active': { state: 'failed', since: 1 } }
  assert.equal(summarizeBackgroundActivity(map, 'ws-active'), null)
})

test('summarizeBackgroundActivity prefers failed over completed over working', () => {
  const map: WorkspaceActivityMap = {
    'ws-1': { state: 'working', since: 1 },
    'ws-2': { state: 'completed', since: 1 },
    'ws-3': { state: 'failed', since: 1 },
  }
  const summary = summarizeBackgroundActivity(map, 'ws-active')
  assert.equal(summary?.colorClass, 'bg-error')
  assert.match(summary?.label ?? '', /another workspace/)

  delete map['ws-3']
  assert.equal(summarizeBackgroundActivity(map, 'ws-active')?.colorClass, 'bg-success')

  delete map['ws-2']
  assert.equal(summarizeBackgroundActivity(map, 'ws-active')?.colorClass, 'bg-accent')
})

test('summarizeBackgroundActivity yields nothing for needs-approval only', () => {
  const map: WorkspaceActivityMap = { 'ws-1': { state: 'needs-approval', since: 1 } }
  assert.equal(summarizeBackgroundActivity(map, 'ws-active'), null)
})
