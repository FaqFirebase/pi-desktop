import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { IPC_CHANNELS, type GitBranchSwitchResult, type SessionRuntimeActivity } from '../../shared/ipc-contracts'
import { RENDERER_INDEX_PATH } from '../renderer-origin'
import type { IpcContext } from './context'

// One stub for every test: the handler module keeps the electron exports it
// was first imported with, so each test registers into this same map.
const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
const electronStub = {
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => handlers.set(channel, handler) },
  app: { on: () => {}, isPackaged: false, getAppPath: () => process.cwd() },
}

test('branch IPC validates inputs and workspace activity, switches explicitly, and notifies file consumers', async () => {
  const require = createRequire(import.meta.url)
  const electronPath = require.resolve('electron')
  require('electron')
  const electronModule = require.cache[electronPath]!
  const originalExports = electronModule.exports
  electronModule.exports = electronStub
  const root = await mkdtemp(join(tmpdir(), 'pi-branch-ipc-'))
  const git = (args: string[]): string => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  try {
    git(['init'])
    git(['config', 'user.email', 'pi-desktop@example.test'])
    git(['config', 'user.name', 'Pi Desktop Tests'])
    git(['commit', '--allow-empty', '-m', 'initial'])
    const initialBranch = git(['branch', '--show-current'])
    git(['branch', 'target'])
    const { registerGitConveyorHandlers } = await import('./git-conveyor-handlers')
    let activity: SessionRuntimeActivity | null = null
    const events: unknown[][] = []
    registerGitConveyorHandlers({
      workspaceManager: {
        getActiveWorkspace: () => ({ id: 'project', path: root }),
        getActivePanelRoot: () => root,
        getSessionRuntimes: (id: string) => {
          assert.equal(id, 'project')
          return [{ activity }]
        },
      },
      broadcast: (...args: unknown[]) => events.push(args),
    } as unknown as IpcContext)
    const event = { senderFrame: { url: process.env.ELECTRON_RENDERER_URL ?? pathToFileURL(RENDERER_INDEX_PATH).href } }
    const list = handlers.get(IPC_CHANNELS.GIT_LOCAL_BRANCHES)!
    const switchBranch = handlers.get(IPC_CHANNELS.GIT_SWITCH_BRANCH)!
    await assert.rejects(list({}), /Unauthorized/)
    assert.deepEqual(await list(event), [initialBranch, 'target'].sort())
    await assert.rejects(switchBranch({}, 'project', 'target'), /Unauthorized/)
    await assert.rejects(switchBranch(event, 42, 'target'), /must be strings/)
    await assert.rejects(switchBranch(event, 'project', {}), /must be strings/)
    // Expected refusals come back as results: a rejected handler is logged with a stack.
    const refusal = async (workspaceId: string, pattern: RegExp): Promise<void> => {
      const result = await switchBranch(event, workspaceId, 'target') as GitBranchSwitchResult
      assert.equal(result.ok, false)
      assert.match(result.ok ? '' : result.error, pattern)
    }
    await refusal('old-workspace', /workspace changed/)
    for (const blocked of ['working', 'needs-approval'] as const) {
      activity = blocked
      await refusal('project', /Wait for all agents/)
    }
    activity = null
    writeFileSync(join(root, 'untracked.txt'), 'only untracked\n')
    await refusal('project', /Commit or discard/)
    unlinkSync(join(root, 'untracked.txt'))
    assert.equal(git(['branch', '--show-current']), initialBranch)
    assert.deepEqual(events, [])
    activity = 'completed'
    const result = await switchBranch(event, 'project', 'target') as GitBranchSwitchResult
    assert.equal(result.ok && result.status.branch, 'target')
    assert.equal(git(['branch', '--show-current']), 'target')
    assert.deepEqual(events, [[IPC_CHANNELS.EVENT_FILE_CHANGE, { changeType: 'change', relativePath: '.' }]])
  } finally {
    electronModule.exports = originalExports
    await rm(root, { recursive: true, force: true })
  }
})

test('new-branch IPC creates from HEAD while an agent works, refuses bad names as results, and notifies file consumers', async () => {
  const require = createRequire(import.meta.url)
  const electronPath = require.resolve('electron')
  require('electron')
  const electronModule = require.cache[electronPath]!
  const originalExports = electronModule.exports
  electronModule.exports = electronStub
  const root = await mkdtemp(join(tmpdir(), 'pi-new-branch-ipc-'))
  const git = (args: string[]): string => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  try {
    git(['init'])
    git(['config', 'user.email', 'pi-desktop@example.test'])
    git(['config', 'user.name', 'Pi Desktop Tests'])
    git(['commit', '--allow-empty', '-m', 'initial'])
    const initialBranch = git(['branch', '--show-current'])
    const { registerGitConveyorHandlers } = await import('./git-conveyor-handlers')
    const events: unknown[][] = []
    registerGitConveyorHandlers({
      workspaceManager: {
        getActiveWorkspace: () => ({ id: 'project', path: root }),
        getActivePanelRoot: () => root,
        getSessionRuntimes: () => [{ activity: 'working' }],
      },
      broadcast: (...args: unknown[]) => events.push(args),
    } as unknown as IpcContext)
    const event = { senderFrame: { url: process.env.ELECTRON_RENDERER_URL ?? pathToFileURL(RENDERER_INDEX_PATH).href } }
    const createBranch = handlers.get(IPC_CHANNELS.GIT_CREATE_BRANCH)!
    await assert.rejects(createBranch({}, 'project', 'feature'), /Unauthorized/)
    await assert.rejects(createBranch(event, 'project', 7), /must be strings/)
    for (const [workspaceId, name, pattern] of [
      ['old-workspace', 'feature', /workspace changed/],
      ['project', 'bad..name', /not a valid branch name/],
      ['project', initialBranch, /already exists/],
    ] as const) {
      const result = await createBranch(event, workspaceId, name) as GitBranchSwitchResult
      assert.equal(result.ok, false)
      assert.match(result.ok ? '' : result.error, pattern)
    }
    assert.deepEqual(events, [])
    writeFileSync(join(root, 'work.txt'), 'uncommitted\n')
    const result = await createBranch(event, 'project', 'feature/new') as GitBranchSwitchResult
    assert.equal(result.ok && result.status.branch, 'feature/new')
    assert.equal(git(['status', '--porcelain']), '?? work.txt')
    assert.deepEqual(events, [[IPC_CHANNELS.EVENT_FILE_CHANGE, { changeType: 'change', relativePath: '.' }]])

    const commit = handlers.get(IPC_CHANNELS.GIT_CONVEYOR_COMMIT)!
    await assert.rejects(commit(event, { message: 'm', newFiles: ['work.txt'] }), /newFiles a string array with paths/)
    await assert.rejects(commit(event, { message: 'm', paths: ['work.txt'], newFiles: 'work.txt' }), /newFiles a string array/)
    await commit(event, { message: 'add work', paths: ['work.txt'], newFiles: ['work.txt'] })
    assert.equal(git(['show', '--format=', '--name-only', 'HEAD']), 'work.txt')
  } finally {
    electronModule.exports = originalExports
    await rm(root, { recursive: true, force: true })
  }
})
