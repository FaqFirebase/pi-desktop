import assert from 'node:assert/strict'
import { test } from 'node:test'
import { filterSessions, filterWorkspaces, matchesTokens, MAX_SESSION_RESULTS } from './quick-switcher'
import type { SessionListItem, Workspace } from '../../../shared/ipc-contracts'

function session(overrides: Partial<SessionListItem>): SessionListItem {
  return {
    path: '/sessions/s.jsonl',
    name: null,
    preview: null,
    sessionId: 's-1',
    lastModified: 0,
    messageCount: 1,
    projectPath: '/projects/app',
    projectName: 'app',
    ...overrides,
  }
}

function workspace(name: string, path: string): Workspace {
  return { id: `ws-${name}`, name, path, createdAt: 0, lastActiveAt: 0, color: '#000' }
}

test('matchesTokens requires every token across the joined fields', () => {
  assert.equal(matchesTokens('pi gui', ['pi-desktop-gui', null]), true)
  assert.equal(matchesTokens('pi gui', ['pi-desktop', 'gui notes']), true)
  assert.equal(matchesTokens('pi missing', ['pi-desktop-gui']), false)
  assert.equal(matchesTokens('', ['anything']), true)
  assert.equal(matchesTokens('   ', ['anything']), true)
})

test('filterSessions matches name, preview, and project name', () => {
  const sessions = [
    session({ sessionId: 'a', name: 'Fix auth bug' }),
    session({ sessionId: 'b', preview: 'refactor the auth flow' }),
    session({ sessionId: 'c', projectName: 'auth-service' }),
    session({ sessionId: 'd', name: 'Unrelated' }),
  ]
  assert.deepEqual(
    filterSessions(sessions, 'auth').map((s) => s.sessionId),
    ['a', 'b', 'c'],
  )
})

test('filterSessions preserves order and caps results', () => {
  const sessions = Array.from({ length: MAX_SESSION_RESULTS + 5 }, (_, i) =>
    session({ sessionId: `s-${i}`, name: `match ${i}` }),
  )
  const filtered = filterSessions(sessions, 'match')
  assert.equal(filtered.length, MAX_SESSION_RESULTS)
  assert.equal(filtered[0].sessionId, 's-0')
})

test('filterWorkspaces matches by name or path tokens', () => {
  const workspaces = [
    workspace('pi-desktop-gui', '/mnt/projects/pi-desktop-gui'),
    workspace('notes', '/home/user/notes'),
  ]
  assert.deepEqual(
    filterWorkspaces(workspaces, 'desktop').map((w) => w.name),
    ['pi-desktop-gui'],
  )
  assert.deepEqual(
    filterWorkspaces(workspaces, 'home user').map((w) => w.name),
    ['notes'],
  )
  assert.equal(filterWorkspaces(workspaces, '').length, 2)
})
