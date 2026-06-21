import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, writeFile, access } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { configureGuiDataDir, getGuiDataPath } from './app-data-paths'
import { WorkspaceManager } from './workspace-manager'

async function freshDataDir(): Promise<void> {
  configureGuiDataDir(await mkdtemp(join(tmpdir(), 'pi-ws-')))
}

async function project(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'pi-proj-'))
}

/** Initialize a manager and guarantee its watchers are stopped afterward. */
async function withManager(fn: (mgr: WorkspaceManager) => Promise<void>): Promise<void> {
  const mgr = new WorkspaceManager()
  await mgr.initialize()
  try {
    await fn(mgr)
  } finally {
    mgr.stopAll()
  }
}

test('saveWorkspaces writes atomically (no leftover .tmp) and round-trips', async () => {
  await freshDataDir()
  const cfg = getGuiDataPath('workspaces.json')

  await withManager(async (mgr) => {
    await mgr.createWorkspace('Alpha', await project())
    const saved = JSON.parse(await readFile(cfg, 'utf-8'))
    assert.ok(
      saved.workspaces.some((w: { name: string }) => w.name === 'Alpha'),
      'created workspace should be persisted'
    )
    await assert.rejects(() => access(`${cfg}.tmp`), 'temp file must not linger after an atomic write')
  })

  await withManager(async (reloaded) => {
    assert.ok(
      reloaded.getWorkspaces().some((w) => w.name === 'Alpha'),
      'reloaded manager should see the persisted workspace'
    )
  })
})

test('load recovers from .bak when the live workspaces file is corrupted', async () => {
  await freshDataDir()
  const proj = await project()
  const cfg = getGuiDataPath('workspaces.json')

  await withManager(async (mgr) => {
    await mgr.createWorkspace('Alpha', proj) // first save: no .bak yet
    await mgr.createWorkspace('Beta', proj) // second save: backs up the Alpha-only state
  })

  await writeFile(cfg, '{ not valid json', 'utf-8') // simulate external corruption

  await withManager(async (recovered) => {
    const names = recovered.getWorkspaces().map((w) => w.name)
    assert.ok(names.includes('Alpha'), 'should fall back to the .bak instead of losing everything')
  })
})
