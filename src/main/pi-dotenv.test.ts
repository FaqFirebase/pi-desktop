import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { GUI_DATA_ENV_VAR } from './app-data-paths'
import { appLog } from './app-log'
import { loadPiDotenv, piDotenvPath, readPiDotenv } from './pi-dotenv'

// appLog resolves its file under the GUI data dir on its first entry — keep the
// warning test's log out of the real data dir.
process.env[GUI_DATA_ENV_VAR] = join(tmpdir(), `pi-dotenv-log-${process.pid}`)

function writeDotenv(text: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'pi-dotenv-')), '.env')
  writeFileSync(path, text)
  return path
}

test('readPiDotenv returns file variables not already in the environment', () => {
  const path = writeDotenv('# keys\nOPENROUTER_API_KEY="sk-or-file"\nOTHER=from-file\n')
  assert.deepEqual(readPiDotenv(path, { OTHER: 'from-env' }), { OPENROUTER_API_KEY: 'sk-or-file' })
})

test('readPiDotenv yields nothing when the file is missing', () => {
  assert.deepEqual(readPiDotenv(join(tmpdir(), 'no-such-dir-pi-dotenv', '.env'), {}), {})
})

test('readPiDotenv skips malformed lines and keeps the valid ones', () => {
  const path = writeDotenv('=no-key\nnot a pair\nVALID=yes\n"unterminated\n')
  assert.deepEqual(readPiDotenv(path, {}), { VALID: 'yes' })
})

test('the env file lives in the .pi folder of the home directory', () => {
  assert.equal(piDotenvPath('/home/u'), join('/home/u', '.pi', '.env'))
})

test('loadPiDotenv never overrides a variable the app inherited', () => {
  const path = writeDotenv(`${GUI_DATA_ENV_VAR}=from-file\nPI_DOTENV_TEST_ONLY=from-file\n`)
  assert.deepEqual(loadPiDotenv(path), { PI_DOTENV_TEST_ONLY: 'from-file' })
})

test('loadPiDotenv logs an unreadable file and yields nothing', () => {
  // A directory in place of the file fails to read with EISDIR, not ENOENT.
  const dir = mkdtempSync(join(tmpdir(), 'pi-dotenv-'))
  assert.deepEqual(loadPiDotenv(dir), {})
  const warning = appLog.getRecent().find((entry) => entry.level === 'warn' && entry.message === `Could not read ${dir}`)
  assert.ok(warning, 'the unreadable file is surfaced in the app log')
})
