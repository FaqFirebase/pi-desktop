import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcContext } from './context'
import type { InstalledPackage } from '../../shared/ipc-contracts'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'

const ISOLATED_ENV_KEYS = ['HOME', 'PI_CODING_AGENT_DIR'] as const

async function writePackageSettings(dir: string, source: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  const settingsPath = join(dir, 'settings.json')
  await writeFile(settingsPath, JSON.stringify({ packages: [source] }), 'utf-8')
  return settingsPath
}

test('the Pi package list reads global packages from PI_CODING_AGENT_DIR', async () => {
  const require = createRequire(import.meta.url)
  const electronPath = require.resolve('electron')
  require('electron')
  const electronModule = require.cache[electronPath]!
  const originalExports = electronModule.exports
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  electronModule.exports = {
    ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) },
  }
  const base = await mkdtemp(join(tmpdir(), 'pi-packages-agent-dir-'))
  const saved = new Map(ISOLATED_ENV_KEYS.map((key) => [key, process.env[key]]))
  const home = join(base, 'home')
  const cwd = join(base, 'project')
  const agentDir = join(base, 'relocated-agent')
  process.env.HOME = home
  process.env.PI_CODING_AGENT_DIR = agentDir
  try {
    const relocatedSettings = await writePackageSettings(agentDir, 'npm:relocated-package')
    await writePackageSettings(join(home, '.pi', 'agent'), 'npm:default-location-package')
    await mkdir(cwd, { recursive: true })

    const { registerPackageHandlers } = await import('./package-handlers')
    registerPackageHandlers({
      workspaceManager: {
        getActiveWorkspace: () => ({ path: cwd }),
        getActivePiManager: () => ({ getEngineKind: () => 'pi' }),
      },
    } as unknown as IpcContext)
    const packages = await handlers.get(IPC_CHANNELS.PACKAGE_LIST_INSTALLED)!() as InstalledPackage[]

    assert.deepEqual(packages.map(({ name, path }) => ({ name, path })), [
      { name: 'relocated-package', path: relocatedSettings },
    ])
  } finally {
    electronModule.exports = originalExports
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(base, { recursive: true, force: true })
  }
})
