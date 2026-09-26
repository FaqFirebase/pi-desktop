import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Workspace } from '../../../shared/ipc-contracts'
import { chatProjectSelection } from './chat-project-selection'

const project = (id: string, path: string): Workspace => ({
  id, path, name: id, color: '#000', createdAt: 0, lastActiveAt: 0
})

test('composer selection follows the active project, including external switches', () => {
  const first = project('first', '/projects/first')
  const second = project('second', '/projects/second')
  assert.equal(chatProjectSelection(first, '/home/user'), first)
  assert.equal(chatProjectSelection(second, '/home/user'), second)
  // A rejected switch does not change the committed active workspace.
  assert.equal(chatProjectSelection(second, '/home/user'), second)
})

test('No project follows home, and does not stick when switching to a project', () => {
  const home = project('home', '/home/user')
  const next = project('next', '/projects/next')
  assert.equal(chatProjectSelection(home, '/home/user'), null)
  assert.equal(chatProjectSelection(next, '/home/user'), next)
  assert.equal(chatProjectSelection(null, '/home/user'), null)
})

test('active project is shown before the home path has loaded', () => {
  const active = project('active', '/projects/active')
  assert.equal(chatProjectSelection(active, null), active)
})
