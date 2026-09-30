import assert from 'node:assert/strict'
import { before, test } from 'node:test'

type ContextMenuModule = typeof import('./context-menu')
let contextMenu: ContextMenuModule

before(async () => {
  ;(globalThis as unknown as { window: unknown }).window = { piDesktop: {} }
  contextMenu = await import('./context-menu')
})

test('only a scroll by the user closes the context menu, not a scroll the app makes', () => {
  const events: readonly string[] = contextMenu.CONTEXT_MENU_USER_SCROLL_EVENTS
  assert.deepEqual([...events], ['wheel', 'touchmove'])
  assert.equal(events.includes('scroll'), false)
})
