import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NO_CWD_EXE_SEARCH_VARIABLE, childProcessEnv, disableCwdExecutableSearch } from './windows-exe-search'

const WINDOWS_PATH = 'C:\\Windows\\system32'
const POSIX_PATH = '/usr/bin'
/**
 * Other spellings of the same variable. Windows matches environment names in
 * any case, but a plain-object copy of process.env keeps each spelling apart.
 */
const UPPER_CASE_SPELLING = NO_CWD_EXE_SEARCH_VARIABLE.toUpperCase()
const LOWER_CASE_SPELLING = NO_CWD_EXE_SEARCH_VARIABLE.toLowerCase()

/** The app environment after Windows startup. */
function windowsAppEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { Path: WINDOWS_PATH }
  disableCwdExecutableSearch(env, 'win32')
  return env
}

test('startup turns the current-folder search off on Windows only', () => {
  const posixEnv: NodeJS.ProcessEnv = { PATH: POSIX_PATH }
  disableCwdExecutableSearch(posixEnv, 'linux')
  assert.deepEqual(posixEnv, { PATH: POSIX_PATH })

  assert.deepEqual(Object.keys(windowsAppEnv()), ['Path', NO_CWD_EXE_SEARCH_VARIABLE])
})

test('a direct launch drops the variable in every spelling and leaves the caller env alone', () => {
  const spawnEnv = { ...windowsAppEnv(), [UPPER_CASE_SPELLING]: '1', [LOWER_CASE_SPELLING]: '' }

  assert.deepEqual(childProcessEnv(false, spawnEnv), { Path: WINDOWS_PATH })
  assert.ok(NO_CWD_EXE_SEARCH_VARIABLE in spawnEnv, 'the env the caller built is not changed')
})

test('a launch through cmd.exe keeps the variable, so a shim resolves its bare node from PATH', () => {
  const appEnv = windowsAppEnv()
  assert.deepEqual(childProcessEnv(true, { ...appEnv }), appEnv)
})

test('a variable the user set before startup reaches every child unchanged', () => {
  const userEnv: NodeJS.ProcessEnv = { Path: WINDOWS_PATH, [UPPER_CASE_SPELLING]: 'yes' }
  const appEnv = { ...userEnv }
  disableCwdExecutableSearch(appEnv, 'win32')

  assert.deepEqual(appEnv, userEnv, 'no second spelling is added')
  assert.deepEqual(childProcessEnv(false, { ...appEnv }), userEnv)
  assert.deepEqual(childProcessEnv(true, { ...appEnv }), userEnv)
})

test('off Windows every child gets the environment as it is', () => {
  disableCwdExecutableSearch({ PATH: POSIX_PATH }, 'linux')
  const env: NodeJS.ProcessEnv = { PATH: POSIX_PATH, [NO_CWD_EXE_SEARCH_VARIABLE]: '' }
  assert.deepEqual(childProcessEnv(false, { ...env }), env)
})
