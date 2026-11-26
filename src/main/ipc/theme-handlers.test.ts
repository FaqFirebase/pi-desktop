import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IPC_CHANNELS, type UserThemeRecord } from '../../shared/ipc-contracts'
import { THEME_SCHEMA_V1, type ThemeFile } from '../../shared/theme/theme-file'
import { configureGuiDataDir } from '../app-data-paths'

// The handler module binds ipcMain and dialog on import, so the stub goes in first.
const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
const openDialogResult: { canceled: boolean; filePaths: string[] } = { canceled: true, filePaths: [] }
const require = createRequire(import.meta.url)
const electronPath = require.resolve('electron')
require('electron')
require.cache[electronPath]!.exports = {
  ipcMain: { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>) => handlers.set(channel, handler) },
  dialog: { showOpenDialog: async () => openDialogResult },
}

function theme(name: string): ThemeFile {
  return {
    $schema: THEME_SCHEMA_V1, name, kind: 'dark',
    seeds: { app: '#111111', surface: '#222222', text: '#eeeeee', accent: '#3366ff', success: '#33cc66', warning: '#ffcc00', error: '#ff4444' },
  }
}

test('each theme save, import and delete announces the new theme list', async () => {
  const root = await mkdtemp(join(tmpdir(), 'theme-handlers-'))
  configureGuiDataDir(root)
  const announced: UserThemeRecord[][] = []
  const { registerThemeHandlers } = await import('./theme-handlers')
  registerThemeHandlers((themes) => announced.push(themes))
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args)
  const ids = () => announced.at(-1)!.map((record) => record.id)
  try {
    await invoke(IPC_CHANNELS.THEMES_SAVE, theme('Mine'))
    assert.deepEqual(ids(), ['mine'])

    const importPath = join(root, 'imported.json')
    await writeFile(importPath, JSON.stringify(theme('Imported')))
    openDialogResult.canceled = false
    openDialogResult.filePaths = [importPath]
    await invoke(IPC_CHANNELS.THEMES_IMPORT)
    assert.deepEqual(ids(), ['imported', 'mine'])

    await invoke(IPC_CHANNELS.THEMES_DELETE, 'mine')
    assert.deepEqual(ids(), ['imported'])
    assert.equal(announced.length, 3)

    openDialogResult.canceled = true
    await invoke(IPC_CHANNELS.THEMES_IMPORT)
    assert.equal(announced.length, 3, 'a cancelled import changes nothing, so it announces nothing')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
