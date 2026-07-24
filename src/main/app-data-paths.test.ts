import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import {
  GUI_DATA_ENV_VAR,
  GUI_DATA_FILES,
  getCanonicalUserDataDir,
  getExternalGuiDataDir,
  getGuiDataPath,
  getLegacyGuiDataPath,
  getLegacyGuiDataDirs,
  migrateLegacyGuiData,
} from './app-data-paths'

test('getCanonicalUserDataDir appends the canonical dir name', () => {
  assert.equal(getCanonicalUserDataDir('/home/test/.config'), '/home/test/.config/pi-desktop')
  assert.equal(
    getCanonicalUserDataDir('/Users/test/Library/Application Support'),
    '/Users/test/Library/Application Support/pi-desktop'
  )
  assert.equal(
    getCanonicalUserDataDir('C:\\Users\\test\\AppData\\Roaming'),
    'C:\\Users\\test\\AppData\\Roaming/pi-desktop'
  )
})

test('getLegacyGuiDataDirs lists home and electron legacy dirs', () => {
  assert.deepEqual(
    getLegacyGuiDataDirs({ homeDir: '/home/test', appDataDir: '/home/test/.config' }),
    [
      '/home/test/.pi-desktop-gui',
      '/home/test/.config/PI Desktop',
      '/home/test/.config/pi-desktop-gui',
    ]
  )
})

test('getExternalGuiDataDir returns the externally-set override as an absolute path', () => {
  assert.equal(getExternalGuiDataDir({}), undefined)
  assert.equal(getExternalGuiDataDir({ [GUI_DATA_ENV_VAR]: '' }), undefined)
  assert.equal(
    getExternalGuiDataDir({ [GUI_DATA_ENV_VAR]: '/tmp/pi-desktop-scratch' }),
    '/tmp/pi-desktop-scratch'
  )
  assert.equal(
    getExternalGuiDataDir({ [GUI_DATA_ENV_VAR]: 'scratch-profile' }),
    resolve('scratch-profile')
  )
})

test('getGuiDataPath / getLegacyGuiDataPath resolve under the right root', () => {
  assert.equal(
    getGuiDataPath('settings.json', { userDataDir: '/home/test/.config/pi-desktop' }),
    '/home/test/.config/pi-desktop/settings.json'
  )
  assert.equal(
    getLegacyGuiDataPath('settings.json', { homeDir: '/home/test' }),
    '/home/test/.pi-desktop-gui/settings.json'
  )
  const userDataDir = '/home/test/.config/pi-desktop'
  for (const fileName of GUI_DATA_FILES) {
    assert.equal(getGuiDataPath(fileName, { userDataDir }), join(userDataDir, fileName))
  }
})

test('migrateLegacyGuiData copies legacy files but never overwrites existing', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'pi-desktop-app-data-'))
  const homeDir = join(tmp, 'home')
  const appDataDir = join(tmp, 'config')
  const userDataDir = getCanonicalUserDataDir(appDataDir)
  const legacySettings = join(appDataDir, 'pi-desktop-gui', 'settings.json')
  const targetSettings = getGuiDataPath('settings.json', { userDataDir })

  await mkdir(join(legacySettings, '..'), { recursive: true })
  await writeFile(legacySettings, '{"theme":"light"}', 'utf-8')

  await migrateLegacyGuiData({ homeDir, appDataDir, userDataDir })
  assert.equal(await readFile(targetSettings, 'utf-8'), '{"theme":"light"}')

  // A second migration must not clobber an already-migrated file.
  await writeFile(legacySettings, '{"theme":"dark"}', 'utf-8')
  await writeFile(targetSettings, '{"theme":"current"}', 'utf-8')
  await migrateLegacyGuiData({ homeDir, userDataDir })
  assert.equal(await readFile(targetSettings, 'utf-8'), '{"theme":"current"}')

  assert.equal(existsSync(join(appDataDir, 'pi-desktop-gui')), true)
})
