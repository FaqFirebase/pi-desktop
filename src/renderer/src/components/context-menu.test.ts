import assert from 'node:assert/strict'
import { before, test } from 'node:test'

type ContextMenuModule = typeof import('./context-menu')
let contextMenu: ContextMenuModule

before(async () => {
  ;(globalThis as unknown as { window: unknown }).window = { piDesktop: {} }
  // The test run compiles .tsx with the classic JSX transform (the root
  // tsconfig sets no jsx), so the menu items' icons need React in scope.
  Object.assign(globalThis, { React: (await import('react')).default })
  contextMenu = await import('./context-menu')
})

test('only a scroll by the user closes the context menu, not a scroll the app makes', () => {
  const events: readonly string[] = contextMenu.CONTEXT_MENU_USER_SCROLL_EVENTS
  assert.deepEqual([...events], ['wheel', 'touchmove'])
  assert.equal(events.includes('scroll'), false)
})

const SESSION_ID = 'session-a'
const SESSION = {
  path: '/sessions/proj/session-a.jsonl',
  name: null,
  preview: null,
  sessionId: SESSION_ID,
  lastModified: 1,
  messageCount: 0,
  projectPath: '/proj',
  projectName: 'proj',
}
const NO_OP_ACTIONS = {
  onOpen: () => {},
  onArchive: () => {},
  onUnarchive: () => {},
  onDelete: () => {},
}
const PIN_ITEM_IDS = ['session-pin', 'session-unpin']

function pinActions(isPinned: boolean, unpinned: string[] = []) {
  return { isPinned, onPin: () => {}, onUnpin: (sessionId: string) => { unpinned.push(sessionId) } }
}

function menuIds(isArchived: boolean, actions: Parameters<ContextMenuModule['buildSessionContextMenu']>[2]): string[] {
  return contextMenu.buildSessionContextMenu(SESSION, isArchived, actions).map((item) => item.id)
}

test('a session menu without pin actions has no pin item', () => {
  const ids = menuIds(false, NO_OP_ACTIONS)
  assert.equal(PIN_ITEM_IDS.some((id) => ids.includes(id)), false)
})

test('an unpinned session offers Pin before Archive', () => {
  const ids = menuIds(false, { ...NO_OP_ACTIONS, pin: pinActions(false) })
  assert.equal(ids.indexOf('session-pin'), ids.indexOf('divider-session-1') + 1)
  assert.ok(ids.indexOf('session-pin') < ids.indexOf('session-archive'))
})

test('a pinned session offers Unpin and calls onUnpin with its id', () => {
  const unpinned: string[] = []
  const items = contextMenu.buildSessionContextMenu(SESSION, false, { ...NO_OP_ACTIONS, pin: pinActions(true, unpinned) })
  const unpin = items.find((item) => item.id === 'session-unpin')
  assert.ok(unpin)
  void unpin.action()
  assert.deepEqual(unpinned, [SESSION_ID])
})

test('an archived session offers no pin item', () => {
  const ids = menuIds(true, { ...NO_OP_ACTIONS, pin: pinActions(false) })
  assert.equal(PIN_ITEM_IDS.some((id) => ids.includes(id)), false)
})
