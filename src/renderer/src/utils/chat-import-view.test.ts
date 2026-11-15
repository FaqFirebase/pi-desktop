import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ChatImportListItem } from '../../../shared/chat-import'
import { groupChatImportItems, isSelectableChat, toggleGroupSelection } from './chat-import-view'

function item(sourcePath: string, cwd: string | null, modifiedAt: number, cwdExists = true): ChatImportListItem {
  return { sourcePath, sourceSessionId: sourcePath, title: null, cwd, cwdExists, modifiedAt, sizeBytes: 1, alreadyImported: false }
}

test('groupChatImportItems groups by folder, newest first', () => {
  const groups = groupChatImportItems([
    item('a1', '/work/a', 10),
    item('none', null, 100),
    item('b1', '/work/b', 30),
    item('a2', '/work/a/', 50),
    item('b2', '/work/b', 20),
  ])
  assert.deepEqual(groups.map((group) => [group.cwd, group.latestModifiedAt, group.items.map((entry) => entry.sourcePath)]), [
    ['/work/a', 50, ['a2', 'a1']],
    ['/work/b', 30, ['b1', 'b2']],
    [null, 100, ['none']],
  ])
  assert.deepEqual(groupChatImportItems([]), [])
})

test('isSelectableChat needs an existing folder', () => {
  assert.equal(isSelectableChat(item('a', '/work', 1)), true)
  assert.equal(isSelectableChat(item('a', '/work', 1, false)), false)
  assert.equal(isSelectableChat(item('a', null, 1, true)), false)
})

test('toggleGroupSelection selects all selectable then clears', () => {
  const [group] = groupChatImportItems([item('a', '/w', 1), item('b', '/w', 2), item('gone', '/w', 3, false)])
  const first = toggleGroupSelection(new Set(['other']), group)
  assert.deepEqual([...first].sort(), ['a', 'b', 'other'])
  const second = toggleGroupSelection(first, group)
  assert.deepEqual([...second], ['other'])
  const partial = toggleGroupSelection(new Set(['a']), group)
  assert.deepEqual([...partial].sort(), ['a', 'b'])
})
