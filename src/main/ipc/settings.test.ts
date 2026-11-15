import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createRequire } from 'node:module'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkspaceManager } from '../workspace-manager'
import { configureGuiDataDir } from '../app-data-paths'
import { t } from '../../shared/i18n'

const SETTINGS_FILE_NAME = 'settings.json'
const UNREADABLE_SETTINGS = '{ "language": "en", '
/** Valid JSON that is not a settings object. */
const NON_OBJECT_SETTINGS = '[]'

// The settings module binds Electron APIs on import, so the stub goes in first.
const require = createRequire(import.meta.url)
const electronPath = require.resolve('electron')
require('electron')
const electronModule = require.cache[electronPath]!
const originalExports = electronModule.exports

let settingsModule: typeof import('./settings')
const noWorkspaces = { getActiveWorkspace: () => null } as unknown as WorkspaceManager

before(async () => {
  electronModule.exports = {
    ipcMain: { handle: () => undefined },
    shell: {},
    app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => process.cwd() },
  }
  settingsModule = await import('./settings')
})

after(() => {
  electronModule.exports = originalExports
})

async function freshDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-settings-'))
  configureGuiDataDir(dir)
  return dir
}

test('a save refuses to overwrite a settings file it cannot parse', async () => {
  const dir = await freshDataDir()
  const settingsPath = join(dir, SETTINGS_FILE_NAME)
  await writeFile(settingsPath, UNREADABLE_SETTINGS, 'utf-8')

  await assert.rejects(
    settingsModule.saveAppSettings({ hasSeenTrayHint: true }),
    { message: t('errors.settings.unreadable', { path: settingsPath }) },
  )
  assert.equal(await readFile(settingsPath, 'utf-8'), UNREADABLE_SETTINGS)
})

test('concurrent saves keep every change and leave no temp files', async () => {
  const dir = await freshDataDir()

  await Promise.all([
    settingsModule.saveAppSettings({ hasSeenTrayHint: true }),
    settingsModule.saveAppSettings({ minimizeToTrayOnClose: true }),
    settingsModule.saveAppSettings({ runOnStartup: true }),
  ])

  const loaded = await settingsModule.loadAppSettings(noWorkspaces)
  assert.equal(loaded.hasSeenTrayHint, true)
  assert.equal(loaded.minimizeToTrayOnClose, true)
  assert.equal(loaded.runOnStartup, true)
  assert.deepEqual(await readdir(dir), [SETTINGS_FILE_NAME])
})

test('a load started after a save sees that save', async () => {
  await freshDataDir()

  const saved = settingsModule.saveAppSettings({ hasSeenTrayHint: true })
  const loaded = await settingsModule.loadAppSettings(noWorkspaces)
  await saved
  assert.equal(loaded.hasSeenTrayHint, true)
})

/** Collects the files the unreadable-settings listener is told about. */
function recordUnreadableNotices(): string[] {
  const notices: string[] = []
  settingsModule.onUnreadableSettings((settingsPath) => notices.push(settingsPath))
  return notices
}

test('a load that finds the settings file unreadable tells the user once, with its path', async () => {
  const dir = await freshDataDir()
  const settingsPath = join(dir, SETTINGS_FILE_NAME)
  await writeFile(settingsPath, UNREADABLE_SETTINGS, 'utf-8')
  const notices = recordUnreadableNotices()

  const loaded = await settingsModule.loadAppSettings(noWorkspaces)
  await settingsModule.loadAppSettings(noWorkspaces)
  await assert.rejects(settingsModule.saveAppSettings({ hasSeenTrayHint: true }))

  assert.equal(loaded.hasSeenTrayHint, false, 'the load falls back to the defaults')
  assert.deepEqual(notices, [settingsPath], 'the user learns of one file once')
})

test('a save that finds the settings file unreadable tells the user', async () => {
  const dir = await freshDataDir()
  const settingsPath = join(dir, SETTINGS_FILE_NAME)
  await writeFile(settingsPath, NON_OBJECT_SETTINGS, 'utf-8')
  const notices = recordUnreadableNotices()

  await assert.rejects(
    settingsModule.saveAppSettings({ hasSeenTrayHint: true }),
    { message: t('errors.settings.unreadable', { path: settingsPath }) },
  )
  assert.deepEqual(notices, [settingsPath])
  assert.equal(await readFile(settingsPath, 'utf-8'), NON_OBJECT_SETTINGS)
})

test('a missing settings file is not a problem to report', async () => {
  await freshDataDir()
  const notices = recordUnreadableNotices()

  await settingsModule.loadAppSettings(noWorkspaces)
  await settingsModule.saveAppSettings({ hasSeenTrayHint: true })

  assert.deepEqual(notices, [])
})
