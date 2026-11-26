import assert from 'node:assert/strict'
import { test } from 'node:test'
import { statusBarStatuses, subagentStatusLines, SUBAGENT_STATUS_KEYS } from './extension-status-line'

test('the status bar lists statuses by key, as plain single-line text', () => {
  const statuses = {
    'z-last': 'last',
    '0-claude-max': '\x1b[38;2;181;189;104m🧠 5h 35% · wk 27%\x1b[39m',
    'm-multi': 'two\nlines\tand   spaces ',
  }
  assert.deepEqual(statusBarStatuses(statuses), [
    { key: '0-claude-max', text: '🧠 5h 35% · wk 27%' },
    { key: 'm-multi', text: 'two lines and spaces' },
    { key: 'z-last', text: 'last' },
  ])
})

test('the status bar leaves out the subagent statuses and entries with no visible text', () => {
  const statuses = Object.fromEntries(SUBAGENT_STATUS_KEYS.map((key) => [key, `${key} running`]))
  assert.deepEqual(statusBarStatuses({ ...statuses, blank: ' \n ', colorOnly: '\x1b[31m\x1b[39m', kept: 'ok' }), [
    { key: 'kept', text: 'ok' },
  ])
  assert.deepEqual(statusBarStatuses(undefined), [])
})

test('the subagent strip lists the subagent statuses that are set, in their fixed order', () => {
  assert.deepEqual(
    subagentStatusLines({
      'subagents-edit': 'editing',
      other: 'not a subagent status',
      'subagent-slash': '\x1b[2m/run\x1b[22m',
      'subagent-slash-text': '',
    }),
    ['/run', 'editing']
  )
  assert.deepEqual(subagentStatusLines(undefined), [])
})
