import assert from 'node:assert/strict'
import { test } from 'node:test'
import { adjacentTabIndex, moveProjectTab, projectTabs, sessionTabs } from './tab-navigation'
import type { SessionRuntimeInfo, Workspace } from '../../../shared/ipc-contracts'

const workspace = (id: string, createdAt: number): Workspace => ({ id, createdAt, name: id, path: `/${id}`, lastActiveAt: 0, color: '' })
const runtime = (runtimeId: string, workspaceId: string, sessionPath: string | null): SessionRuntimeInfo => ({
  runtimeId, workspaceId, sessionPath, sessionId: null, activity: null, active: false, status: 'running', pid: null, error: null,
})

test('navigation wraps in both directions and handles empty or unselected tabs', () => {
  assert.equal(adjacentTabIndex(0, 3, 'next'), 1)
  assert.equal(adjacentTabIndex(2, 3, 'next'), 0)
  assert.equal(adjacentTabIndex(2, 3, 'previous'), 1)
  assert.equal(adjacentTabIndex(0, 3, 'previous'), 2)
  for (const direction of ['previous', 'next'] as const) {
    assert.equal(adjacentTabIndex(-1, 0, direction), null)
    assert.equal(adjacentTabIndex(0, 1, direction), 0)
  }
  assert.equal(adjacentTabIndex(-1, 3, 'next'), 0)
  assert.equal(adjacentTabIndex(-1, 3, 'previous'), 2)
})

test('project order follows creation time, not recent activation, without mutating the store list', () => {
  const workspaces = [workspace('c', 3), workspace('a', 1), workspace('b', 2)]
  workspaces[0].lastActiveAt = 100
  assert.deepEqual(projectTabs(workspaces).map((tab) => tab.id), ['a', 'b', 'c'])
  assert.deepEqual(workspaces.map((tab) => tab.id), ['c', 'a', 'b'])
})

test('custom project order survives recent activation, ignores closed projects and appends new ones', () => {
  const workspaces = [workspace('newer', 5), workspace('a', 1), workspace('b', 2), workspace('new', 4)]
  const order = ['b', 'closed', 'a']
  workspaces[1].lastActiveAt = 100
  assert.deepEqual(projectTabs(workspaces, order).map((tab) => tab.id), ['b', 'a', 'new', 'newer'])
  assert.deepEqual(order, ['b', 'closed', 'a'])
})

test('moving a project inserts before or after the target in either direction without mutation', () => {
  const order = ['a', 'b', 'c', 'd']
  assert.deepEqual(moveProjectTab(order, 'a', 'c', 'before'), ['b', 'a', 'c', 'd'])
  assert.deepEqual(moveProjectTab(order, 'a', 'd', 'after'), ['b', 'c', 'd', 'a'])
  assert.deepEqual(moveProjectTab(order, 'd', 'a', 'before'), ['d', 'a', 'b', 'c'])
  assert.deepEqual(moveProjectTab(order, 'd', 'b', 'after'), ['a', 'b', 'd', 'c'])
  assert.deepEqual(order, ['a', 'b', 'c', 'd'])
  for (const placement of ['before', 'after'] as const) {
    assert.equal(moveProjectTab(order, 'a', 'a', placement), order)
    assert.equal(moveProjectTab(order, 'closed', 'a', placement), order)
    assert.equal(moveProjectTab(order, 'a', 'closed', placement), order)
  }
})

test('session order includes only open tabs in this project, newest first', () => {
  const runtimes = {
    first: runtime('first', 'project', '/first'),
    other: runtime('other', 'other-project', '/other'),
    starting: runtime('starting', 'project', null),
    last: runtime('last', 'project', '/last'),
  }
  assert.deepEqual(sessionTabs(runtimes, 'project').map((tab) => tab.runtimeId), ['last', 'first'])
  runtimes.first.active = true
  assert.deepEqual(sessionTabs(runtimes, 'project').map((tab) => tab.runtimeId), ['last', 'first'])
  assert.deepEqual(sessionTabs(runtimes, undefined), [])
})
