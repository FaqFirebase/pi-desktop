import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, writeFile, access } from 'fs/promises'
import { existsSync } from 'fs'
import { spawnSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { configureGuiDataDir, getGuiDataPath } from './app-data-paths'
import { PiRpcManager } from './pi-rpc-manager'
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

test('workspaceIdFor reverse-maps a manager to its owning workspace', async () => {
  await freshDataDir()

  await withManager(async (mgr) => {
    const alpha = await mgr.createWorkspace('Alpha', await project())
    const beta = await mgr.createWorkspace('Beta', await project())
    const alphaManager = mgr.getPiManager(alpha.id)
    const betaManager = mgr.getPiManager(beta.id)
    assert.ok(alphaManager && betaManager, 'each workspace should own a Pi manager')
    assert.equal(mgr.workspaceIdFor(alphaManager), alpha.id)
    assert.equal(mgr.workspaceIdFor(betaManager), beta.id)
    assert.equal(mgr.workspaceIdFor(new PiRpcManager()), null, 'an unowned manager must map to nothing')
  })
})

test('multiple session runtimes share a project cwd without sharing a Pi process', async () => {
  await freshDataDir()

  await withManager(async (mgr) => {
    const ws = await mgr.createWorkspace('Alpha', await project())
    const fallback = mgr.getPiManager(ws.id)
    const first = await mgr.createNewSessionRuntime(ws.id)
    const second = await mgr.createNewSessionRuntime(ws.id)

    assert.notEqual(first.runtimeId, second.runtimeId)
    assert.notEqual(mgr.getActivePiManager(), fallback, 'the active session runtime replaces the workspace fallback')
    assert.equal(mgr.getSessionRuntimes(ws.id).length, 2)
    assert.equal(mgr.workspaceIdFor(mgr.getActivePiManager()!), ws.id)

    const existingPath = join(await project(), 'session.jsonl')
    await writeFile(existingPath, '{}\n', 'utf-8')
    const activated = await mgr.activateSession(ws.id, existingPath)
    assert.equal(activated.sessionPath, existingPath)
    assert.equal(mgr.getSessionRuntimeForPath(existingPath)?.runtimeId, activated.runtimeId)
    assert.equal(mgr.getActiveSessionRuntime()?.runtimeId, activated.runtimeId)
  })
})

test('changeWorkspacePath stops the workspace Pi so it cannot keep the old cwd', async () => {
  await freshDataDir()

  await withManager(async (mgr) => {
    const ws = await mgr.createWorkspace('Alpha', await project())
    const piManager = mgr.getPiManager(ws.id)
    assert.ok(piManager, 'the workspace should own a Pi manager')
    let stopped = false
    piManager.stop = () => {
      stopped = true
    }

    await mgr.changeWorkspacePath(ws.id, await project())

    assert.equal(stopped, true, "Pi's cwd is bound at spawn; a repoint must stop it")
  })
})

test('creates and removes a clean managed worktree tab', async () => {
  await freshDataDir()
  const repo = await project()
  await writeFile(join(repo, 'README.md'), 'worktree test\\n', 'utf-8')
  const git = (args: string[], cwd = repo): string => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf-8' })
    assert.equal(result.status, 0, result.stderr || `git ${args.join(' ')} failed`)
    return result.stdout.trim()
  }
  git(['init'])
  git(['config', 'user.email', 'pi-desktop@example.test'])
  git(['config', 'user.name', 'Pi Desktop Tests'])
  git(['add', '.'])
  git(['commit', '-m', 'initial'])

  await withManager(async (mgr) => {
    await mgr.createWorkspace('Repo', repo)
    const tab = await mgr.createWorktreeWorkspace()

    assert.equal(tab.kind, 'worktree')
    assert.equal(tab.branch, 'pi/repo-tab-' + tab.id.replace(/^ws-/, ''))
    assert.equal(existsSync(tab.path), true)
    assert.equal(git(['branch', '--show-current'], tab.path), tab.branch)

    const result = await mgr.removeWorkspace(tab.id)
    assert.equal(result.worktreeRemoved, true)
    assert.equal(result.preservedWorktreePath, undefined)
    assert.equal(existsSync(tab.path), false)

    await writeFile(join(repo, 'source-dirty.txt'), 'stays in source\\n', 'utf-8')
    const dirtySourceTab = await mgr.createWorktreeWorkspace()
    assert.equal(dirtySourceTab.sourceWasDirty, true)
    assert.equal(existsSync(join(dirtySourceTab.path, 'source-dirty.txt')), false)
    await mgr.removeWorkspace(dirtySourceTab.id)
  })
})

test('reuses the same managed worktree for the same task', async () => {
  await freshDataDir()
  const repo = await project()
  await writeFile(join(repo, 'README.md'), 'task reuse\n', 'utf-8')
  const git = (args: string[], cwd = repo): string => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf-8' })
    assert.equal(result.status, 0, result.stderr || `git ${args.join(' ')} failed`)
    return result.stdout.trim()
  }
  git(['init'])
  git(['config', 'user.email', 'pi-desktop@example.test'])
  git(['config', 'user.name', 'Pi Desktop Tests'])
  git(['add', '.'])
  git(['commit', '-m', 'initial'])

  await withManager(async (mgr) => {
    const source = await mgr.createWorkspace('Repo', repo)
    const task = 'Fix the task reuse test'
    const first = await mgr.createWorktreeWorkspace({
      sourceWorkspaceId: source.id,
      name: 'Fix task reuse',
      taskPrompt: task,
    })
    const second = await mgr.createWorktreeWorkspace({
      sourceWorkspaceId: source.id,
      name: 'Should not create another tab',
      taskPrompt: task,
    })

    assert.equal(second.id, first.id)
    assert.equal(mgr.getWorkspaces().filter((workspace) => workspace.kind === 'worktree').length, 1)
    await mgr.removeWorkspace(first.id)
  })
})

test('adopts an explicitly named external worktree without deleting it on close', async () => {
  await freshDataDir()
  const repo = await project()
  await writeFile(join(repo, 'README.md'), 'external worktree\n', 'utf-8')
  const git = (args: string[], cwd = repo): string => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf-8' })
    assert.equal(result.status, 0, result.stderr || `git ${args.join(' ')} failed`)
    return result.stdout.trim()
  }
  git(['init'])
  git(['config', 'user.email', 'pi-desktop@example.test'])
  git(['config', 'user.name', 'Pi Desktop Tests'])
  git(['add', '.'])
  git(['commit', '-m', 'initial'])
  const external = join(await project(), 'checkout')
  git(['worktree', 'add', '-b', 'feature/existing', external])

  await withManager(async (mgr) => {
    const source = await mgr.createWorkspace('Repo', repo)
    const adopted = await mgr.createWorktreeWorkspace({
      sourceWorkspaceId: source.id,
      taskPrompt: 'Continue work in feature/existing',
    })

    assert.equal(adopted.path.replaceAll('\\', '/'), external.replaceAll('\\', '/'))
    assert.equal(adopted.branch, 'feature/existing')
    assert.equal(adopted.managed, false)
    const result = await mgr.removeWorkspace(adopted.id)
    assert.equal(result.worktreeRemoved, undefined)
    assert.equal(existsSync(external), true)
  })

  git(['worktree', 'remove', external])
})

test('closing a session runtime removes its tab and only marks empty sessions disposable', async () => {
  await freshDataDir()

  await withManager(async (mgr) => {
    const workspace = await mgr.createWorkspace('Alpha', await project())
    const emptyPath = join(await project(), 'empty.jsonl')
    await writeFile(emptyPath, JSON.stringify({ type: 'session', id: 'empty' }) + '\n', 'utf-8')
    const emptyRuntime = await mgr.activateSession(workspace.id, emptyPath)

    const contentPath = join(await project(), 'content.jsonl')
    await writeFile(contentPath, [
      JSON.stringify({ type: 'session', id: 'content' }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'keep me' }] } }),
    ].join('\n') + '\n', 'utf-8')
    const contentRuntime = await mgr.activateSession(workspace.id, contentPath)
    const pruned = await mgr.pruneEmptySessionRuntimes()
    const contentResult = await mgr.closeSessionRuntime(contentRuntime.runtimeId)

    assert.equal(pruned.some((result) => result.runtimeId === emptyRuntime.runtimeId && result.empty), true)
    assert.equal(mgr.getSessionRuntime(emptyRuntime.runtimeId), null)
    assert.equal(contentResult?.empty, false)
    assert.equal(existsSync(contentPath), true)
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
