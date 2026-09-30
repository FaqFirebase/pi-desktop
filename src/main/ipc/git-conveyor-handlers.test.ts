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
