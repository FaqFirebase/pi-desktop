import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TERMINAL_TYPE, buildTerminalEnv } from './terminal-service'
import { NO_CWD_EXE_SEARCH_VARIABLE, disableCwdExecutableSearch } from './windows-exe-search'

test('the terminal shell does not inherit the current-folder search switch', () => {
  // The shell is the user's own tool: `build.bat` typed in a project folder
  // must run as it does in any other terminal.
  const appEnv: NodeJS.ProcessEnv = { Path: 'C:\\Windows\\system32' }
  disableCwdExecutableSearch(appEnv, 'win32')
  try {
    const shellEnv = buildTerminalEnv(appEnv)
    assert.equal(NO_CWD_EXE_SEARCH_VARIABLE in shellEnv, false)
    assert.equal(shellEnv.Path, appEnv.Path)
    assert.equal(shellEnv.TERM, TERMINAL_TYPE)
  } finally {
    disableCwdExecutableSearch({}, process.platform)
  }
})
