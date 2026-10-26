import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, readFile, writeFile, access, realpath, symlink } from 'fs/promises'
import { existsSync } from 'fs'
import { spawnSync } from 'child_process'
import { tmpdir } from 'os'
import { basename, join, resolve } from 'path'
import {
  WHOLE_WORKSPACE_CHANGE_PATH,
  type AgentEngineKind,
  type RepoSet,
  type PiProcessStatus,
  type PiStartOptions,
  type SessionRuntimeCloseResult,
  type SessionRuntimeInfo,
} from '../shared/ipc-contracts'
import { configureGuiDataDir, getGuiDataPath } from './app-data-paths'
import { isPathWithin } from '../../resources/path-within'
import { REPO_MAP_ENV, parseRepoMap } from '../../resources/repo-set-map'
import { getOmpSessionsRoot, getSessionsRoot } from './pi-paths'
import { PiRpcManager, setPiExecutableOverride } from './pi-rpc-manager'
import { isDisposableSessionFile, MAX_LIVE_SESSION_RUNTIMES, WorkspaceManager } from './workspace-manager'

async function freshDataDir(): Promise<void> {
  configureGuiDataDir(await mkdtemp(join(tmpdir(), 'pi-ws-')))
}

async function project(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'pi-proj-'))
}

/**
 * Point the data directory at a symlink, so Git's physical worktree paths and
 * the app's own data paths spell the same checkout two ways.
 */
async function symlinkedDataDir(): Promise<void> {
  const data = await mkdtemp(join(tmpdir(), 'pi-ws-'))
  const alias = join(await project(), 'gui-data')
  await symlink(data, alias, 'junction')
  configureGuiDataDir(alias)
}

/**
 * Run with each engine's session store redirected into its own temp tree, so a
 * fixture can be placed in the store that decides which engine owns it.
 */
async function withSessionStores(
  fn: (roots: { pi: string; omp: string }) => Promise<void>
): Promise<void> {
  const saved = {
    pi: process.env.PI_CODING_AGENT_DIR,
    omp: process.env.OMP_CODING_AGENT_DIR,
  }
  process.env.PI_CODING_AGENT_DIR = await mkdtemp(join(tmpdir(), 'pi-agent-'))
  process.env.OMP_CODING_AGENT_DIR = await mkdtemp(join(tmpdir(), 'omp-agent-'))
  try {
    await fn({ pi: getSessionsRoot(), omp: getOmpSessionsRoot() })
  } finally {
    for (const [key, value] of [
      ['PI_CODING_AGENT_DIR', saved.pi],
      ['OMP_CODING_AGENT_DIR', saved.omp],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** Write a session file into one engine's store, laid out the way it lays them out. */
async function storedSession(root: string, name: string, ...records: object[]): Promise<string> {
  const projectDir = join(root, '--tmp-app--')
  await mkdir(projectDir, { recursive: true })
  const path = join(projectDir, name)
  await writeFile(path, records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf-8')
  return path
}

/** Make the manager's get_state report the session file the agent wrote. */
function reportsSessionFile(manager: PiRpcManager, sessionPath: string, sessionId: string): void {
  manager.sendCommand = async () => ({
    type: 'response',
    command: 'get_state',
    success: true,
    data: { sessionFile: sessionPath, sessionId },
  })
}

/** Where tests pretend the app ships its agent extensions. */
const TEST_RESOURCES_DIR = join(tmpdir(), 'pi-desktop-test-resources')

/** Initialize a manager and guarantee its watchers are stopped afterward. */
async function withManager(fn: (mgr: WorkspaceManager) => Promise<void>): Promise<void> {
  const mgr = new WorkspaceManager((fileName) => join(TEST_RESOURCES_DIR, fileName))
  await mgr.initialize()
  try {
    await fn(mgr)
  } finally {
    mgr.stopAll()
  }
}

interface FakePiProcess {
  stopped: boolean
  starts: number
  /** Options the manager was last started with, for asserting on the argv. */
  lastStartOptions: PiStartOptions | null
}

/**
 * Give a manager the observable behaviour of a live Pi child process without
 * spawning one: a status that flips on start/stop, and the status-change event
 * the real manager emits from setStatus().
 */
function fakePiProcess(
  manager: PiRpcManager,
  pid: number,
  initial: PiProcessStatus = 'running'
): FakePiProcess {
  const state: FakePiProcess = { stopped: false, starts: 0, lastStartOptions: null }
  let status = initial
  const setStatus = (next: PiProcessStatus): void => {
    if (status === next) return
    status = next
    manager.emit('status-change', status)
  }
  manager.getStatus = () => ({ status, pid: status === 'stopped' ? null : pid, error: null })
  manager.stop = (): void => {
    state.stopped = true
    setStatus('stopped')
  }
  manager.start = async (options: PiStartOptions = {}) => {
    state.starts += 1
    state.lastStartOptions = options
    setStatus('running')
    return manager.getStatus()
  }
  return state
}

/** How many runtimes currently hold a Pi child process. */
function liveRuntimeCount(mgr: WorkspaceManager): number {
  return mgr.getSessionRuntimes()
    .filter((runtime) => runtime.status === 'running' || runtime.status === 'starting')
    .length
}

/** Create a session runtime, then give it a fake live process. */
async function liveRuntime(
  mgr: WorkspaceManager,
  workspaceId: string,
  pid: number,
  initial: PiProcessStatus = 'running'
): Promise<{ runtime: SessionRuntimeInfo; process: FakePiProcess }> {
  const runtime = await mgr.createNewSessionRuntime(workspaceId)
  const manager = mgr.getActivePiManager()
  assert.ok(manager, 'a new session runtime owns the active Pi manager')
  return { runtime, process: fakePiProcess(manager, pid, initial) }
}

/** Initialize a Git repository and return a runner bound to it. */
function gitRepo(repo: string): (args: string[], cwd?: string) => string {
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
  return git
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

test('activateRuntime switches the active runtime exactly, never by path', async () => {
  await freshDataDir()

  await withManager(async (mgr) => {
    const ws = await mgr.createWorkspace('Alpha', await project())
    const first = await mgr.createNewSessionRuntime(ws.id)
    const filePath = join(await project(), 'session.jsonl')
    await writeFile(filePath, '{}\n', 'utf-8')
    await mgr.activateSession(ws.id, filePath)
    assert.equal(mgr.getActiveSessionRuntime()?.runtimeId, mgr.getSessionRuntimeForPath(filePath)?.runtimeId)

    // Reactivating the FIRST file-less tab must land on it, not on the
    // workspace's remembered runtime or any path-derived tab.
    const activated = await mgr.activateRuntime(ws.id, first.runtimeId)
    assert.equal(activated.runtimeId, first.runtimeId)
    assert.equal(mgr.getActiveSessionRuntime()?.runtimeId, first.runtimeId)
    assert.equal(mgr.getWorkspaceSessionRuntime(ws.id)?.runtimeId, first.runtimeId)
    assert.equal(mgr.getActiveSessionRuntime()?.sessionPath, null, 'a file-less tab stays file-less')
  })
})

test('activateRuntime validates the target instead of falling back', async () => {
  await freshDataDir()

  await withManager(async (mgr) => {
    const ws = await mgr.createWorkspace('Alpha', await project())
    const other = await mgr.createWorkspace('Beta', await project())
    const runtime = await mgr.createNewSessionRuntime(ws.id)
    await assert.rejects(() => mgr.activateRuntime(ws.id, 'rt-missing'), /Session runtime not found/)
    await assert.rejects(() => mgr.activateRuntime(other.id, runtime.runtimeId), /attached to a different workspace runtime/)
    await assert.rejects(() => mgr.activateRuntime('ws-missing', runtime.runtimeId), /Workspace not found/)
    assert.equal(mgr.getActiveSessionRuntime()?.runtimeId, runtime.runtimeId, 'failed activation leaves the active pointer alone')
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
  const git = gitRepo(repo)

  await withManager(async (mgr) => {
    await mgr.createWorkspace('Repo', repo)
    const tab = await mgr.createWorktreeWorkspace()

    assert.equal(tab.kind, 'worktree')
    assert.equal(tab.branch, 'pi/repo-tab-' + tab.id.replace(/^ws-/, ''))
    assert.equal(existsSync(tab.path), true)
    assert.equal(git(['branch', '--show-current'], tab.path), tab.branch)

    const result = await mgr.removeWorkspace(tab.id)
    assert.equal(result.worktreeRemoved, true)
    assert.equal(result.preservedWorktreePaths, undefined)
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
  gitRepo(repo)

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

test('adopts an explicitly named leftover worktree without deleting it on close', async () => {
  await symlinkedDataDir()
  const repo = await project()
  await writeFile(join(repo, 'README.md'), 'leftover worktree\n', 'utf-8')
  const git = gitRepo(repo)
  // A worktree left behind under the app's own root, e.g. one preserved because
  // it was still dirty when its tab closed. Only this root is reusable.
  const leftover = join(getGuiDataPath('worktrees'), 'leftover-checkout')
  git(['worktree', 'add', '-b', 'feature/existing', leftover])

  await withManager(async (mgr) => {
    const source = await mgr.createWorkspace('Repo', repo)
    const adopted = await mgr.createWorktreeWorkspace({
      sourceWorkspaceId: source.id,
      taskPrompt: 'Continue work in feature/existing',
    })

    assert.equal(await realpath(adopted.path), await realpath(leftover))
    assert.equal(adopted.branch, 'feature/existing')
    assert.equal(adopted.managed, false)
    const result = await mgr.removeWorkspace(adopted.id)
    assert.equal(result.worktreeRemoved, undefined)
    assert.equal(existsSync(leftover), true)
  })

  git(['worktree', 'remove', leftover])
})

test('a task naming an open tab\'s branch returns that tab, not a second one', async () => {
  await symlinkedDataDir()
  const repo = await project()
  await writeFile(join(repo, 'README.md'), 'open tab\n', 'utf-8')
  gitRepo(repo)

  await withManager(async (mgr) => {
    const source = await mgr.createWorkspace('Repo', repo)
    const tab = await mgr.createWorktreeWorkspace({ sourceWorkspaceId: source.id })
    const again = await mgr.createWorktreeWorkspace({
      sourceWorkspaceId: source.id,
      taskPrompt: `Continue work in ${tab.branch}`,
    })

    // Two tabs on one checkout would let closing the first remove the folder
    // the second still works in.
    assert.equal(again.id, tab.id)
    assert.equal(mgr.getWorkspaces().filter((workspace) => workspace.kind === 'worktree').length, 1)
    await mgr.removeWorkspace(tab.id)
  })
})

test('a task run from a tab never adopts that same tab\'s checkout', async () => {
  await symlinkedDataDir()
  const repo = await project()
  await writeFile(join(repo, 'README.md'), 'source tab\n', 'utf-8')
  gitRepo(repo)

  await withManager(async (mgr) => {
    const repoWorkspace = await mgr.createWorkspace('Repo', repo)
    const sourceTab = await mgr.createWorktreeWorkspace({ sourceWorkspaceId: repoWorkspace.id })
    const task = await mgr.createWorktreeWorkspace({
      sourceWorkspaceId: sourceTab.id,
      taskPrompt: `Continue work in ${sourceTab.branch}`,
    })

    assert.notEqual(task.id, sourceTab.id)
    assert.notEqual(await realpath(task.path), await realpath(sourceTab.path))
    assert.equal(task.managed, true, 'the task gets a fresh checkout of its own')
    await mgr.removeWorkspace(task.id)
    await mgr.removeWorkspace(sourceTab.id)
  })
})

test('never reuses the main checkout or a worktree the user made', async () => {
  await freshDataDir()
  const repo = await project()
  await writeFile(join(repo, 'README.md'), 'main checkout\n', 'utf-8')
  const git = gitRepo(repo)
  // The user's primary checkout sits on a group/name branch, and they keep a
  // second checkout of their own outside the app's worktree root.
  git(['checkout', '-b', 'feature/main-work'])
  const userWorktree = join(await project(), 'user-checkout')
  git(['worktree', 'add', '-b', 'feature/user-side', userWorktree])

  await withManager(async (mgr) => {
    const repoWorkspace = await mgr.createWorkspace('Repo', repo)
    // Run the task from a managed tab, so the source is itself a linked
    // worktree and the main checkout is just another entry in the list.
    const sourceTab = await mgr.createWorktreeWorkspace({ sourceWorkspaceId: repoWorkspace.id })

    const fromMainBranch = await mgr.createWorktreeWorkspace({
      sourceWorkspaceId: sourceTab.id,
      taskPrompt: 'Continue work in feature/main-work',
    })
    assert.notEqual(fromMainBranch.id, repoWorkspace.id, 'a task must never hand back the source project tab')
    assert.notEqual(resolve(fromMainBranch.path), resolve(repo), 'the main checkout must never be reused')
    assert.equal(
      isPathWithin(getGuiDataPath('worktrees'), fromMainBranch.path),
      true,
      'the task must get a fresh worktree under the app root instead'
    )

    const fromUserWorktree = await mgr.createWorktreeWorkspace({
      sourceWorkspaceId: sourceTab.id,
      taskPrompt: 'Continue work in feature/user-side',
    })
    assert.notEqual(
      resolve(fromUserWorktree.path),
      resolve(userWorktree),
      'a worktree outside the app root belongs to the user'
    )
    assert.equal(isPathWithin(getGuiDataPath('worktrees'), fromUserWorktree.path), true)

    // Both user checkouts are untouched: same branch, same files.
    assert.equal(git(['branch', '--show-current'], repo), 'feature/main-work')
    assert.equal(git(['branch', '--show-current'], userWorktree), 'feature/user-side')

    await mgr.removeWorkspace(fromUserWorktree.id)
    await mgr.removeWorkspace(fromMainBranch.id)
    await mgr.removeWorkspace(sourceTab.id)
    assert.equal(existsSync(repo), true)
    assert.equal(existsSync(userWorktree), true)
  })

  git(['worktree', 'remove', userWorktree])
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

    const imagePath = join(await project(), 'image-only.jsonl')
    await writeFile(imagePath, [
      JSON.stringify({ type: 'session', id: 'image-only' }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'image', source: { data: 'AAAA' } }] } }),
    ].join('\n') + '\n', 'utf-8')
    const imageRuntime = await mgr.activateSession(workspace.id, imagePath)
    const imageResult = await mgr.closeSessionRuntime(imageRuntime.runtimeId)
    assert.equal(imageResult?.empty, false)
    assert.equal(existsSync(imagePath), true)
  })
})

test('a session starts on the engine that owns its store, not the configured default', async () => {
  await freshDataDir()

  await withSessionStores(async (roots) => {
    await withManager(async (mgr) => {
      const workspace = await mgr.createWorkspace('Alpha', await project())

      // Opened from the session list, the way session-handlers starts it.
      const ompPath = await storedSession(roots.omp, 'omp.jsonl', { type: 'session', id: 'omp' })
      const ompRuntime = await mgr.activateSession(workspace.id, ompPath)
      const ompManager = mgr.getActivePiManager()
      assert.ok(ompManager, 'the activated session owns the active manager')
      const ompProcess = fakePiProcess(ompManager, 601, 'stopped')
      await mgr.startSessionRuntime(ompRuntime.runtimeId, { sessionPath: ompPath })
      assert.equal(ompProcess.lastStartOptions?.engine, 'omp')
      assert.equal(ompProcess.lastStartOptions?.sessionPath, ompPath)

      // Restarting an evicted tab passes no session path, so the engine has to
      // survive on the runtime's own remembered file.
      const piPath = await storedSession(roots.pi, 'pi.jsonl', { type: 'session', id: 'pi' })
      const piRuntime = await mgr.activateSession(workspace.id, piPath)
      const piManager = mgr.getActivePiManager()
      assert.ok(piManager)
      const piProcess = fakePiProcess(piManager, 602, 'stopped')
      await mgr.startSessionRuntime(piRuntime.runtimeId)
      assert.equal(piProcess.lastStartOptions?.engine, 'pi')

      // A brand-new session belongs to no store yet, so it uses the engine the
      // user configured.
      const fresh = await mgr.createNewSessionRuntime(workspace.id)
      const freshManager = mgr.getActivePiManager()
      assert.ok(freshManager)
      const freshProcess = fakePiProcess(freshManager, 603, 'stopped')
      await mgr.startSessionRuntime(fresh.runtimeId)
      assert.equal(freshProcess.lastStartOptions?.engine, undefined)
    })
  })
})

test('an OMP session subscribes to subagent progress when it starts; a Pi session does not', async () => {
  await freshDataDir()

  await withSessionStores(async (roots) => {
    await withManager(async (mgr) => {
      const workspace = await mgr.createWorkspace('Alpha', await project())
      const cases: Array<{ engine: AgentEngineKind; file: string; pid: number }> = [
        { engine: 'omp', file: 'omp.jsonl', pid: 611 },
        { engine: 'pi', file: 'pi.jsonl', pid: 612 },
      ]
      for (const { engine, file, pid } of cases) {
        const path = await storedSession(engine === 'omp' ? roots.omp : roots.pi, file, { type: 'session', id: engine })
        const runtime = await mgr.activateSession(workspace.id, path)
        const manager = mgr.getActivePiManager()
        assert.ok(manager)
        fakePiProcess(manager, pid, 'stopped')
        const sent: Array<Record<string, unknown>> = []
        manager.getEngineKind = () => engine
        manager.sendCommand = async (command) => {
          sent.push(command)
          return null
        }
        await mgr.startSessionRuntime(runtime.runtimeId, { sessionPath: path })
        const subscribed = sent.some((command) => command.type === 'set_subagent_subscription' && command.level === 'progress')
        assert.equal(subscribed, engine === 'omp', engine)
      }
    })
  })
})

test('an OMP runtime in the home directory opts into --allow-home; Pi and other folders do not', async () => {
  await freshDataDir()
  const home = await mkdtemp(join(tmpdir(), 'pi-home-'))
  const savedHome = process.env.HOME
  process.env.HOME = home
  try {
    await withManager(async (mgr) => {
      const homeWorkspace = await mgr.createWorkspace('Home', home, { activate: false })
      const elsewhere = await mgr.createWorkspace('Elsewhere', await project(), { activate: false })

      // A brand-new task names no engine: the configured default decides, so
      // the Home guard has to look at the engine that will actually run —
      // exactly the "No project" first send under a default-OMP install.
      setPiExecutableOverride(null, 'omp')
      const cases: Array<{ label: string; workspace: string; engine?: AgentEngineKind; expectFlag: boolean }> = [
        { label: 'omp in HOME (explicit engine)', workspace: homeWorkspace.id, engine: 'omp', expectFlag: true },
        { label: 'omp in HOME (configured default)', workspace: homeWorkspace.id, expectFlag: true },
        { label: 'pi in HOME', workspace: homeWorkspace.id, engine: 'pi', expectFlag: false },
        { label: 'omp elsewhere', workspace: elsewhere.id, engine: 'omp', expectFlag: false },
      ]
      for (const { label, workspace, engine, expectFlag } of cases) {
        const runtime = await mgr.createNewSessionRuntime(workspace)
        const manager = mgr.getSessionRuntimeManager(runtime.runtimeId)
        assert.ok(manager)
        const process_ = fakePiProcess(manager, 620, 'stopped')
        await mgr.startSessionRuntime(runtime.runtimeId, engine ? { engine } : {})
        const args = process_.lastStartOptions?.args ?? []
        assert.equal(
          args.includes('--allow-home'), expectFlag,
          `${label}: --allow-home ${expectFlag ? 'required (session header must keep the home cwd)' : 'must not be injected'}`,
        )
        await mgr.closeSessionRuntime(runtime.runtimeId)
      }
    })
  } finally {
    // An assertion failure above must not leave later tests spawning the OMP
    // override this test installed, so the reset runs on every exit path.
    setPiExecutableOverride(null, 'auto')
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
  }
})

test('every start path records the permission mode the process actually received', async () => {
  await freshDataDir()
  await withManager(async (mgr) => {
    const workspace = await mgr.createWorkspace('Alpha', await project())
    const runtime = await mgr.createNewSessionRuntime(workspace.id)
    const manager = mgr.getSessionRuntimeManager(runtime.runtimeId)
    assert.ok(manager)
    const process_ = fakePiProcess(manager, 630, 'stopped')
    assert.equal(mgr.getSessionRuntimePermissionMode(runtime.runtimeId), null, 'nothing recorded before any start')
    // A start through the manager itself (the main window's new-session and
    // restart paths), not the popup's start helper: the recorded mode comes
    // from the env the process is spawned with.
    await mgr.startSessionRuntime(runtime.runtimeId, {
      env: { PI_DESKTOP_PERMISSION_MODE: 'ask-commands' },
    })
    assert.equal(process_.lastStartOptions?.env?.PI_DESKTOP_PERMISSION_MODE, 'ask-commands')
    assert.equal(mgr.getSessionRuntimePermissionMode(runtime.runtimeId), 'ask-commands', 'the convergence point recorded the env mode')
    await mgr.closeSessionRuntime(runtime.runtimeId)
    assert.equal(mgr.getSessionRuntimePermissionMode(runtime.runtimeId), null, 'cleared on close')
  })
})

test('a closed tab is only disposable when this run created its session file', async () => {
  await freshDataDir()

  await withSessionStores(async (roots) => {
    await withManager(async (mgr) => {
      const workspace = await mgr.createWorkspace('Alpha', await project())

      // A header-only file the user opened from the list. It reads empty, but
      // it is theirs — closing the tab must never delete it.
      const adopted = await storedSession(roots.pi, 'adopted.jsonl', { type: 'session', id: 'adopted' })
      const adoptedRuntime = await mgr.activateSession(workspace.id, adopted)
      const adoptedClose = await mgr.closeSessionRuntime(adoptedRuntime.runtimeId)
      assert.ok(adoptedClose)
      assert.equal(adoptedClose.empty, true)
      assert.equal(adoptedClose.appCreated, false)
      assert.equal(isDisposableSessionFile(adoptedClose), false)

      // A New Session tab whose agent wrote a fresh file: ours to discard.
      const created = await mgr.createNewSessionRuntime(workspace.id)
      const createdManager = mgr.getActivePiManager()
      assert.ok(createdManager)
      const createdProcess = fakePiProcess(createdManager, 701, 'stopped')
      const createdPath = await storedSession(roots.pi, 'created.jsonl', { type: 'session', id: 'created' })
      reportsSessionFile(createdManager, createdPath, 'created')
      await mgr.startSessionRuntime(created.runtimeId)

      // A permission-rules change restarts every live runtime with the resume
      // preference applied. This tab already owns a file, so --session outranks
      // --continue and the tab keeps both its session and its own authorship.
      await mgr.startSessionRuntime(created.runtimeId, { continueSession: true })
      assert.equal(createdProcess.lastStartOptions?.sessionPath, createdPath)

      const createdClose = await mgr.closeSessionRuntime(created.runtimeId)
      assert.ok(createdClose)
      assert.equal(createdClose.sessionPath, createdPath)
      assert.equal(createdClose.appCreated, true)
      assert.equal(isDisposableSessionFile(createdClose), true)

      // The same New Session tab with the resume preference on: --continue
      // binds it to whatever session already existed for this cwd, so the file
      // stops being ours the moment it starts.
      const resumed = await mgr.createNewSessionRuntime(workspace.id)
      const resumedManager = mgr.getActivePiManager()
      assert.ok(resumedManager)
      fakePiProcess(resumedManager, 702, 'stopped')
      const resumedPath = await storedSession(roots.pi, 'resumed.jsonl', { type: 'session', id: 'resumed' })
      reportsSessionFile(resumedManager, resumedPath, 'resumed')
      await mgr.startSessionRuntime(resumed.runtimeId, { continueSession: true })
      const resumedClose = await mgr.closeSessionRuntime(resumed.runtimeId)
      assert.ok(resumedClose)
      assert.equal(resumedClose.empty, true)
      assert.equal(resumedClose.appCreated, false)
      assert.equal(isDisposableSessionFile(resumedClose), false)
    })
  })
})

test('a restart before the first answer starts a new session, not a missing or older one', async () => {
  await freshDataDir()

  await withSessionStores(async (roots) => {
    await withManager(async (mgr) => {
      const workspace = await mgr.createWorkspace('Alpha', await project())
      const runtime = await mgr.createNewSessionRuntime(workspace.id)
      const manager = mgr.getActivePiManager()
      assert.ok(manager)
      const process = fakePiProcess(manager, 801, 'stopped')
      // The engine names the session file at once but writes it only after
      // its first answer. Nothing was sent, so the file is not on disk.
      const unwritten = join(roots.omp, '--tmp-app--', 'not-written-yet.jsonl')
      reportsSessionFile(manager, unwritten, 'not-written-yet')
      await mgr.startSessionRuntime(runtime.runtimeId)
      assert.equal(existsSync(unwritten), false)

      // A permission mode change restarts with the resume preference applied.
      // OMP refuses a --session file that does not exist, and --continue would
      // open an earlier conversation in this empty tab.
      await mgr.startSessionRuntime(runtime.runtimeId, { continueSession: true })
      assert.equal(process.lastStartOptions?.sessionPath, undefined)
      assert.notEqual(process.lastStartOptions?.continueSession, true)

      // Once the file exists, a restart re-opens it as before.
      await storedSession(roots.omp, 'not-written-yet.jsonl', { type: 'session', id: 'not-written-yet' })
      await mgr.startSessionRuntime(runtime.runtimeId, { continueSession: true })
      assert.equal(process.lastStartOptions?.sessionPath, unwritten)
    })
  })
})

test('the auto-delete guard refuses a file it cannot prove is a throwaway', async () => {
  await withSessionStores(async (roots) => {
    const inStore = await storedSession(roots.pi, 'guard.jsonl', { type: 'session', id: 'guard' })
    const base: SessionRuntimeCloseResult = {
      runtimeId: 'rt-guard',
      workspaceId: 'ws-guard',
      sessionPath: inStore,
      empty: true,
      appCreated: true,
      deleted: false,
    }
    assert.equal(isDisposableSessionFile(base), true)

    // An unreadable or partial read leaves `empty` false; that is a session
    // with content as far as this app is concerned.
    assert.equal(isDisposableSessionFile({ ...base, empty: false }), false)
    assert.equal(isDisposableSessionFile({ ...base, appCreated: false }), false)
    assert.equal(isDisposableSessionFile({ ...base, sessionPath: null }), false)
    // Outside every store: the runtime's path is reported by the agent, so a
    // wrong or hostile one must not reach unlink.
    assert.equal(
      isDisposableSessionFile({ ...base, sessionPath: join(await project(), 'loose.jsonl') }),
      false
    )
    assert.equal(
      isDisposableSessionFile({ ...base, sessionPath: join(roots.pi, '--tmp-app--', 'gone.jsonl') }),
      false
    )
  })
})

test('caps live Pi processes by stopping the least recently used idle runtime', async () => {
  await freshDataDir()

  await withManager(async (mgr) => {
    const workspace = await mgr.createWorkspace('Alpha', await project())
    const sessionPath = join(await project(), 'oldest.jsonl')
    await writeFile(sessionPath, JSON.stringify({ type: 'session', id: 'oldest' }) + '\n', 'utf-8')
    const oldest = await mgr.activateSession(workspace.id, sessionPath)
    const oldestManager = mgr.getActivePiManager()
    assert.ok(oldestManager, 'the activated session owns the active Pi manager')
    const oldestProcess = fakePiProcess(oldestManager, 9000)

    const opened = []
    for (let index = 1; index < MAX_LIVE_SESSION_RUNTIMES; index++) {
      opened.push(await liveRuntime(mgr, workspace.id, 9000 + index))
    }
    assert.equal(liveRuntimeCount(mgr), MAX_LIVE_SESSION_RUNTIMES, 'the cap is reached but not breached')

    const seen: SessionRuntimeInfo[] = []
    mgr.onSessionRuntime((runtime) => seen.push(runtime))
    const before = seen.length

    const extra = await liveRuntime(mgr, workspace.id, 9100)

    assert.equal(oldestProcess.stopped, true, 'the least recently used idle runtime loses its process')
    assert.equal(
      opened.filter((item) => item.process.stopped).length,
      0,
      'exactly one runtime is evicted, not every idle one'
    )
    assert.equal(liveRuntimeCount(mgr), MAX_LIVE_SESSION_RUNTIMES, 'the new process fits inside the cap')

    // The tab survives; only the process is gone, and the renderer is told.
    const evicted = mgr.getSessionRuntime(oldest.runtimeId)
    assert.equal(evicted?.status, 'stopped')
    assert.equal(evicted?.sessionPath, sessionPath, 'an evicted runtime keeps its session')
    assert.equal(existsSync(sessionPath), true, 'eviction must never delete the session file')
    const emitted = seen.slice(before).filter((runtime) => runtime.runtimeId === oldest.runtimeId)
    assert.equal(emitted.at(-1)?.status, 'stopped', 'the tab must not keep showing a dead process as live')
    assert.equal(emitted.at(-1)?.closed, undefined, 'eviction stops a tab, it does not close it')

    // Re-activating the evicted tab spawns again and stays inside the cap.
    await mgr.activateSession(workspace.id, sessionPath)
    const restarted = await mgr.startSessionRuntime(oldest.runtimeId)

    assert.equal(restarted.runtimeId, oldest.runtimeId, 'the same tab is reused')
    assert.equal(oldestProcess.starts, 1, 'a fresh Pi process is started for the same session file')
    assert.equal(opened[0].process.stopped, true, 'the next least recently used runtime makes room')
    assert.equal(extra.process.stopped, false, 'a runtime used a moment ago is not the eviction target')
    assert.equal(liveRuntimeCount(mgr), MAX_LIVE_SESSION_RUNTIMES)
  })
})

test('eviction spares the active, starting, and mid-turn runtimes', async () => {
  await freshDataDir()

  await withManager(async (mgr) => {
    const workspace = await mgr.createWorkspace('Alpha', await project())
    const working = await liveRuntime(mgr, workspace.id, 9200)
    const approving = await liveRuntime(mgr, workspace.id, 9201)
    const starting = await liveRuntime(mgr, workspace.id, 9202, 'starting')
    const idleOlder = await liveRuntime(mgr, workspace.id, 9203)
    const idleNewer = await liveRuntime(mgr, workspace.id, 9204)
    const active = await liveRuntime(mgr, workspace.id, 9205)
    mgr.setSessionRuntimeActivity(working.runtime.runtimeId, 'working')
    mgr.setSessionRuntimeActivity(approving.runtime.runtimeId, 'needs-approval')
    assert.equal(mgr.getActiveSessionRuntime()?.runtimeId, active.runtime.runtimeId)

    const overflow = await liveRuntime(mgr, workspace.id, 9206)

    assert.equal(idleOlder.process.stopped, true, 'the oldest idle runtime is the only valid victim')
    for (const spared of [working, approving, starting, idleNewer, active, overflow]) {
      assert.equal(spared.process.stopped, false, 'a protected or newer runtime must keep its process')
    }

    // With every remaining runtime protected, the cap is exceeded on purpose:
    // losing a turn the user waits on is worse than one extra process.
    mgr.setSessionRuntimeActivity(idleNewer.runtime.runtimeId, 'working')
    mgr.setSessionRuntimeActivity(active.runtime.runtimeId, 'needs-approval')
    const beyondCap = await liveRuntime(mgr, workspace.id, 9207)

    assert.equal(
      [working, approving, starting, idleNewer, active, overflow, beyondCap]
        .some((item) => item.process.stopped),
      false,
      'no unevictable runtime may be killed to honour the cap'
    )
    assert.equal(liveRuntimeCount(mgr), MAX_LIVE_SESSION_RUNTIMES + 1)
  })
})

test('a live runtime never loses its session file to another runtime', async () => {
  await freshDataDir()

  await withManager(async (mgr) => {
    const workspace = await mgr.createWorkspace('Alpha', await project())
    const ownedPath = join(await project(), 'owned.jsonl')
    await writeFile(ownedPath, JSON.stringify({ type: 'session', id: 'owned' }) + '\n', 'utf-8')
    const owner = await mgr.activateSession(workspace.id, ownedPath)
    const ownerManager = mgr.getActivePiManager()
    assert.ok(ownerManager, 'the activated session owns the active Pi manager')
    const ownerProcess = fakePiProcess(ownerManager, 9300)

    const newcomer = await mgr.createNewSessionRuntime(workspace.id)
    const newcomerManager = mgr.getActivePiManager()
    assert.ok(newcomerManager, 'the new session owns the active Pi manager')
    const newcomerProcess = fakePiProcess(newcomerManager, 9301)
    // Pi reports a session file that already has a live writer.
    newcomerManager.sendCommand = async () => ({
      type: 'response',
      command: 'get_state',
      success: true,
      data: { sessionFile: ownedPath, sessionId: 'owned' },
    })

    const refreshed = await mgr.refreshSessionRuntime(newcomer.runtimeId)

    assert.equal(
      mgr.getSessionRuntimeForPath(ownedPath)?.runtimeId,
      owner.runtimeId,
      'the runtime that already holds the session keeps it'
    )
    assert.equal(refreshed?.sessionPath, null, 'the newcomer must not claim a session it does not own')
    assert.equal(newcomerProcess.stopped, true, 'two Pi processes must never write one session JSONL')
    assert.equal(refreshed?.activity, 'failed', 'the renderer is told the runtime could not attach')
    assert.equal(ownerProcess.stopped, false, 'the owning runtime keeps running')
    assert.equal(mgr.getSessionRuntime(owner.runtimeId)?.sessionPath, ownedPath)
    assert.equal(existsSync(ownedPath), true)
  })
})

// ─── A New Task's prompt ─────────────────────────────────────────────────────
// A launched task shows as working before its prompt goes out, and only a turn
// end clears that. These answers start no turn.

const NO_KEY = 'No API key found for anthropic.'
const PROMPT_ACCEPTED = { type: 'response', command: 'prompt', success: true }

/** A launched task's runtime whose engine answers each command with `answer`. */
async function launchedTask(
  mgr: WorkspaceManager,
  answer: (command: Record<string, unknown>, manager: PiRpcManager) => unknown
): Promise<{ runtimeId: string; manager: PiRpcManager; commands: string[] }> {
  const workspace = await mgr.createWorkspace('Alpha', await project())
  const { runtime } = await liveRuntime(mgr, workspace.id, 9400)
  const manager = mgr.getActivePiManager()!
  const commands: string[] = []
  manager.sendCommand = async (command) => {
    commands.push(String(command.type))
    return answer(command, manager) as Awaited<ReturnType<PiRpcManager['sendCommand']>>
  }
  mgr.setSessionRuntimeActivity(runtime.runtimeId, 'working')
  return { runtimeId: runtime.runtimeId, manager, commands }
}

function stateAnswer(isStreaming: boolean): unknown {
  return { type: 'response', command: 'get_state', success: true, data: { isStreaming } }
}

test('a task prompt the engine refuses fails the task and keeps the reason for its chat', async () => {
  await freshDataDir()

  await withManager(async (mgr) => {
    const task = await launchedTask(mgr, () => ({ type: 'response', command: 'prompt', success: false, error: NO_KEY }))
    const seen: SessionRuntimeInfo[] = []
    mgr.onSessionRuntime((runtime) => seen.push(runtime))

    await mgr.promptSessionRuntime(task.runtimeId, 'fix the bug')

    const settled = mgr.getSessionRuntime(task.runtimeId)
    assert.equal(settled?.activity, 'failed', 'a refused prompt must not stay working')
    assert.equal(settled?.promptRefusal, NO_KEY)
    assert.equal(seen.at(-1)?.promptRefusal, NO_KEY, 'the renderer is told why')
    assert.deepEqual(task.commands, ['prompt'])
  })
})

test('a refusal without a reason still fails the task', async () => {
  await freshDataDir()

  await withManager(async (mgr) => {
    const task = await launchedTask(mgr, () => ({ type: 'response', command: 'prompt', success: false }))

    await mgr.promptSessionRuntime(task.runtimeId, 'fix the bug')

    assert.equal(mgr.getSessionRuntime(task.runtimeId)?.activity, 'failed')
    assert.equal(mgr.getSessionRuntime(task.runtimeId)?.promptRefusal, '')
  })
})

// Pi runs an extension command before it answers and starts no turn for it.
test('a task prompt that runs no turn completes the task', async () => {
  await freshDataDir()

  await withManager(async (mgr) => {
    const task = await launchedTask(mgr, (command) => command.type === 'prompt' ? PROMPT_ACCEPTED : stateAnswer(false))

    await mgr.promptSessionRuntime(task.runtimeId, '/status')

    assert.equal(mgr.getSessionRuntime(task.runtimeId)?.activity, 'completed')
    assert.equal(mgr.getSessionRuntime(task.runtimeId)?.promptRefusal, undefined)
    assert.deepEqual(task.commands, ['prompt', 'get_state'])
  })
})

test('a task prompt whose turn runs stays working until the turn ends', async () => {
  await freshDataDir()

  await withManager(async (mgr) => {
    const task = await launchedTask(mgr, (command) => command.type === 'prompt' ? PROMPT_ACCEPTED : stateAnswer(true))

    await mgr.promptSessionRuntime(task.runtimeId, 'fix the bug')

    assert.equal(mgr.getSessionRuntime(task.runtimeId)?.activity, 'working')
    task.manager.emit('agent_end', { type: 'agent_end', messages: [] })
    assert.equal(mgr.getSessionRuntime(task.runtimeId)?.activity, 'completed')
  })
})

test('a turn that started before the answer settles the task by itself', async () => {
  await freshDataDir()

  await withManager(async (mgr) => {
    const task = await launchedTask(mgr, (command, manager) => {
      if (command.type !== 'prompt') return stateAnswer(false)
      manager.emit('agent_start', { type: 'agent_start' })
      return PROMPT_ACCEPTED
    })

    await mgr.promptSessionRuntime(task.runtimeId, '/review')

    assert.equal(mgr.getSessionRuntime(task.runtimeId)?.activity, 'working')
    assert.deepEqual(task.commands, ['prompt'], 'a turn that started needs no state check')
  })
})

test('a turn that starts while the state is read is not settled by the read', async () => {
  await freshDataDir()

  await withManager(async (mgr) => {
    const task = await launchedTask(mgr, (command, manager) => {
      if (command.type === 'prompt') return PROMPT_ACCEPTED
      manager.emit('agent_start', { type: 'agent_start' })
      return stateAnswer(false)
    })

    await mgr.promptSessionRuntime(task.runtimeId, '/review')

    assert.equal(mgr.getSessionRuntime(task.runtimeId)?.activity, 'working')
  })
})

test('an OMP local command completes the task without a state check', async () => {
  await freshDataDir()

  await withManager(async (mgr) => {
    const task = await launchedTask(mgr, () => ({ ...PROMPT_ACCEPTED, data: { agentInvoked: false } }))

    await mgr.promptSessionRuntime(task.runtimeId, '/context')

    assert.equal(mgr.getSessionRuntime(task.runtimeId)?.activity, 'completed')
    assert.deepEqual(task.commands, ['prompt'])
  })
})

// OMP answers a prompt when it admits it, and reports how the prompt ended in
// a prompt_result event: a refusal after admission (no model, no API key), an
// extension command that ran no turn, or a turn's end.

/** A launched task on OMP. */
async function launchedOmpTask(
  mgr: WorkspaceManager,
  answer: (command: Record<string, unknown>, manager: PiRpcManager) => unknown
): Promise<{ runtimeId: string; manager: PiRpcManager; commands: string[] }> {
  const task = await launchedTask(mgr, answer)
  task.manager.getEngineKind = () => 'omp'
  return task
}

const OMP_REFUSED_AFTER_ADMISSION = {
  type: 'prompt_result', id: 'prompt-1', agentInvoked: false, status: 'error', error: { message: NO_KEY, retryable: false },
}
const OMP_COMMAND_FINISHED = { type: 'prompt_result', id: 'prompt-1', agentInvoked: false, status: 'completed' }

test('an OMP task refused after admission fails with the reason of its prompt_result', async () => {
  await freshDataDir()

  await withManager(async (mgr) => {
    const task = await launchedOmpTask(mgr, () => PROMPT_ACCEPTED)

    await mgr.promptSessionRuntime(task.runtimeId, 'fix the bug')

    assert.equal(mgr.getSessionRuntime(task.runtimeId)?.activity, 'working', 'OMP reports the outcome later')
    assert.deepEqual(task.commands, ['prompt'], 'OMP reports the outcome, so no state check')
    task.manager.emit('prompt_result', OMP_REFUSED_AFTER_ADMISSION)
    const settled = mgr.getSessionRuntime(task.runtimeId)
    assert.equal(settled?.activity, 'failed', 'a refused task must not stay working')
    assert.equal(settled?.promptRefusal, NO_KEY)
  })
})

test('an OMP prompt_result that comes before the prompt answer settles the task', async () => {
  await freshDataDir()

  await withManager(async (mgr) => {
    const task = await launchedOmpTask(mgr, (command, manager) => {
      if (command.type === 'prompt') manager.emit('prompt_result', OMP_REFUSED_AFTER_ADMISSION)
      return PROMPT_ACCEPTED
    })

    await mgr.promptSessionRuntime(task.runtimeId, 'fix the bug')

    assert.equal(mgr.getSessionRuntime(task.runtimeId)?.activity, 'failed', 'the later answer does not undo the refusal')
    assert.equal(mgr.getSessionRuntime(task.runtimeId)?.promptRefusal, NO_KEY)
  })
})

test('an OMP extension command completes the task when its prompt_result says so, not before', async () => {
  await freshDataDir()

  await withManager(async (mgr) => {
    const task = await launchedOmpTask(mgr, (command) => command.type === 'prompt' ? PROMPT_ACCEPTED : stateAnswer(false))

    await mgr.promptSessionRuntime(task.runtimeId, '/review')

    assert.equal(mgr.getSessionRuntime(task.runtimeId)?.activity, 'working', 'the command still runs after admission')
    task.manager.emit('prompt_result', OMP_COMMAND_FINISHED)
    assert.equal(mgr.getSessionRuntime(task.runtimeId)?.activity, 'completed')
    assert.equal(mgr.getSessionRuntime(task.runtimeId)?.promptRefusal, undefined)
  })
})

test('an OMP prompt_result after a turn leaves the task to that turn', async () => {
  await freshDataDir()

  await withManager(async (mgr) => {
    const task = await launchedOmpTask(mgr, () => PROMPT_ACCEPTED)
    await mgr.promptSessionRuntime(task.runtimeId, 'fix the bug')

    task.manager.emit('agent_start', { type: 'agent_start' })
    task.manager.emit('agent_end', { type: 'agent_end', messages: [] })
    task.manager.emit('prompt_result', { ...OMP_REFUSED_AFTER_ADMISSION, agentInvoked: true })

    assert.equal(mgr.getSessionRuntime(task.runtimeId)?.activity, 'completed')
    assert.equal(mgr.getSessionRuntime(task.runtimeId)?.promptRefusal, undefined, 'a turn ran, so nothing was refused')
  })
})

test('a prompt_result of a prompt that is not a task prompt changes nothing', async () => {
  await freshDataDir()

  await withManager(async (mgr) => {
    const task = await launchedOmpTask(mgr, () => PROMPT_ACCEPTED)

    task.manager.emit('prompt_result', OMP_REFUSED_AFTER_ADMISSION)

    assert.equal(mgr.getSessionRuntime(task.runtimeId)?.activity, 'working')
    assert.equal(mgr.getSessionRuntime(task.runtimeId)?.promptRefusal, undefined)
  })
})

test('a turn after a refused task prompt clears the refusal', async () => {
  await freshDataDir()

  await withManager(async (mgr) => {
    const task = await launchedTask(mgr, () => ({ type: 'response', command: 'prompt', success: false, error: NO_KEY }))
    await mgr.promptSessionRuntime(task.runtimeId, 'fix the bug')

    task.manager.emit('agent_start', { type: 'agent_start' })

    const runtime = mgr.getSessionRuntime(task.runtimeId)
    assert.equal(runtime?.activity, 'working')
    assert.equal(runtime?.promptRefusal, undefined, 'the chat has moved on from the refused prompt')
  })
})

test('answering an approval resumes only its runtime after its last pending request', async () => {
  await freshDataDir()
  await withManager(async (mgr) => {
    const task = await launchedTask(mgr, () => PROMPT_ACCEPTED)
    task.manager.emit('agent_start', { type: 'agent_start' })
    task.manager.emit('extension_ui_request', { id: 'first', method: 'confirm' })
    task.manager.emit('extension_ui_request', { id: 'second', method: 'input' })
    assert.equal(mgr.getSessionRuntime(task.runtimeId)?.activity, 'needs-approval')

    task.manager.emit('extension-ui-response', 'unrelated')
    task.manager.emit('extension-ui-response', 'first')
    task.manager.emit('extension-ui-response', 'first')
    assert.equal(mgr.getSessionRuntime(task.runtimeId)?.activity, 'needs-approval')

    task.manager.emit('extension-ui-response', 'second')
    assert.equal(mgr.getSessionRuntime(task.runtimeId)?.activity, 'working')
  })
})

test('canceling startup approval restores idle and late answers cannot reopen a finished turn', async () => {
  await freshDataDir()
  await withManager(async (mgr) => {
    const workspace = await mgr.createWorkspace('Alpha', await project())
    const { runtime } = await liveRuntime(mgr, workspace.id, 9450)
    const manager = mgr.getSessionRuntimeManager(runtime.runtimeId)!
    manager.emit('extension_ui_request', { id: 'startup', method: 'select' })
    assert.equal(mgr.getSessionRuntime(runtime.runtimeId)?.activity, 'needs-approval')
    manager.emit('extension_ui_request', { method: 'cancel', targetId: 'startup' })
    assert.equal(mgr.getSessionRuntime(runtime.runtimeId)?.activity, null)

    manager.emit('extension_ui_request', { id: 'turn', method: 'confirm' })
    manager.emit('agent_start', { type: 'agent_start' })
    assert.equal(mgr.getSessionRuntime(runtime.runtimeId)?.activity, 'needs-approval')
    manager.emit('extension-ui-response', 'turn')
    assert.equal(mgr.getSessionRuntime(runtime.runtimeId)?.activity, 'working')
    manager.emit('extension_ui_request', { id: 'late', method: 'editor' })
    manager.emit('agent_end', { type: 'agent_end', messages: [] })
    manager.emit('extension-ui-response', 'late')
    assert.equal(mgr.getSessionRuntime(runtime.runtimeId)?.activity, 'completed')
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

test('no disk watcher is attached until the renderer demands change events', async () => {
  await freshDataDir()

  await withManager(async (mgr) => {
    const workspace = await mgr.createWorkspace('Alpha', await project())
    assert.equal(mgr.getActiveWorkspace()?.id, workspace.id)
    assert.equal(
      mgr.getWatchedWorkspaceId(),
      null,
      'cold start with an active workspace must not pay the chokidar cost'
    )
  })
})

test('file watch demand attaches to and detaches from the active workspace', async () => {
  await freshDataDir()

  await withManager(async (mgr) => {
    const workspace = await mgr.createWorkspace('Alpha', await project())

    mgr.setFileWatchDemand(true)
    assert.equal(mgr.getWatchedWorkspaceId(), workspace.id)

    mgr.setFileWatchDemand(true)
    assert.equal(mgr.getWatchedWorkspaceId(), workspace.id, 'repeat demand must be a no-op')

    mgr.setFileWatchDemand(false)
    assert.equal(mgr.getWatchedWorkspaceId(), null)
  })
})

test('file watch demand follows the active workspace across switches', async () => {
  await freshDataDir()

  await withManager(async (mgr) => {
    const alpha = await mgr.createWorkspace('Alpha', await project())
    const beta = await mgr.createWorkspace('Beta', await project())

    mgr.setFileWatchDemand(true)
    assert.equal(mgr.getWatchedWorkspaceId(), alpha.id)

    await mgr.setActiveWorkspace(beta.id)
    assert.equal(
      mgr.getWatchedWorkspaceId(),
      beta.id,
      'switching workspaces with the files panel open must move the watcher'
    )

    mgr.setFileWatchDemand(false)
    assert.equal(mgr.getWatchedWorkspaceId(), null)
  })
})

test('file watch demand re-arms on the new path after changeWorkspacePath', async () => {
  await freshDataDir()

  await withManager(async (mgr) => {
    const workspace = await mgr.createWorkspace('Alpha', await project())

    mgr.setFileWatchDemand(true)
    assert.equal(mgr.getWatchedWorkspaceId(), workspace.id)

    await mgr.changeWorkspacePath(workspace.id, await project())
    assert.equal(
      mgr.getWatchedWorkspaceId(),
      workspace.id,
      'repointing the folder must re-arm the watcher on the new FileService'
    )
  })
})

test('workspace switches stay watcher-free while nothing is demanded', async () => {
  await freshDataDir()

  await withManager(async (mgr) => {
    await mgr.createWorkspace('Alpha', await project())
    const beta = await mgr.createWorkspace('Beta', await project())

    await mgr.setActiveWorkspace(beta.id)
    assert.equal(mgr.getWatchedWorkspaceId(), null)
  })
})

/** Time the git watcher needs to resolve the git directory and start. */
const GIT_WATCH_START_MS = 500
/** Upper bound for a branch change to be reported: the debounce plus watcher start-up. */
const GIT_CHANGE_REPORT_WITHIN_MS = 2_000

test('a branch created outside the app is reported for the active workspace without file watch demand', async () => {
  await freshDataDir()
  const repo = await project()
  await writeFile(join(repo, 'README.md'), '# app\n')
  const git = gitRepo(repo)

  await withManager(async (mgr) => {
    const changes: string[] = []
    mgr.onFileChange((event) => changes.push(event.relativePath))
    await mgr.createWorkspace('Alpha', repo)
    assert.equal(mgr.getWatchedWorkspaceId(), null, 'no disk watcher without demand')

    await new Promise((resolveWait) => setTimeout(resolveWait, GIT_WATCH_START_MS))
    git(['branch', 'from-terminal'])
    const started = Date.now()
    while (changes.length === 0 && Date.now() - started < GIT_CHANGE_REPORT_WITHIN_MS) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50))
    }
    assert.deepEqual(changes, [WHOLE_WORKSPACE_CHANGE_PATH])
  })
})

test('demand set before any workspace attaches on first activation', async () => {
  await freshDataDir()

  await withManager(async (mgr) => {
    mgr.setFileWatchDemand(true)
    assert.equal(mgr.getWatchedWorkspaceId(), null, 'no workspace, nothing to watch')

    const workspace = await mgr.createWorkspace('Alpha', await project())
    assert.equal(
      mgr.getWatchedWorkspaceId(),
      workspace.id,
      'the first activation must honor pre-existing demand'
    )
  })
})

test('removing the watched workspace migrates the watcher while demanded', async () => {
  await freshDataDir()

  await withManager(async (mgr) => {
    const alpha = await mgr.createWorkspace('Alpha', await project())
    await mgr.createWorkspace('Beta', await project())
    mgr.setFileWatchDemand(true)
    assert.equal(mgr.getWatchedWorkspaceId(), alpha.id)

    await mgr.removeWorkspace(alpha.id)
    assert.equal(
      mgr.getWatchedWorkspaceId(),
      mgr.getActiveWorkspace()?.id,
      'removal must move the watcher to the promoted workspace'
    )
  })
})

test('stopAll stops the watcher', async () => {
  await freshDataDir()

  await withManager(async (mgr) => {
    const workspace = await mgr.createWorkspace('Alpha', await project())
    mgr.setFileWatchDemand(true)
    assert.equal(mgr.getWatchedWorkspaceId(), workspace.id)

    mgr.stopAll()
    assert.equal(mgr.getWatchedWorkspaceId(), null, 'quit must leave no watcher attached')
  })
})

test('a workspace names the session runtime its next start reuses, and only once it has one', async () => {
  await freshDataDir()

  await withManager(async (mgr) => {
    const ws = await mgr.createWorkspace('Alpha', await project())
    assert.equal(mgr.getWorkspaceSessionRuntime(ws.id), null, 'the per-workspace fallback manager is not a session runtime')
    const fresh = await mgr.createNewSessionRuntime(ws.id)
    assert.equal(mgr.getWorkspaceSessionRuntime(ws.id)?.runtimeId, fresh.runtimeId)
    assert.equal(mgr.getWorkspaceSessionRuntime(ws.id)?.sessionPath, null)

    const existingPath = join(await project(), 'session.jsonl')
    await writeFile(existingPath, '{}\n', 'utf-8')
    const activated = await mgr.activateSession(ws.id, existingPath)
    assert.equal(mgr.getWorkspaceSessionRuntime(ws.id)?.runtimeId, activated.runtimeId)
    assert.equal(mgr.getWorkspaceSessionRuntime(ws.id)?.sessionPath, existingPath)
  })
})

/** A saved repo set over fresh repositories: `app` is the main one. */
async function repoSetOf(...names: string[]): Promise<{ set: RepoSet; paths: Record<string, string> }> {
  const paths: Record<string, string> = {}
  for (const name of names) {
    const path = await project()
    await writeFile(join(path, 'README.md'), `${name}\n`, 'utf-8')
    gitRepo(path)
    paths[name] = path
  }
  const now = Date.now()
  const set: RepoSet = {
    id: 'rs-test',
    name: 'Shop',
    members: names.map((name, index) => ({ name, sourcePath: paths[name], role: index === 0 ? 'main' : 'linked' })),
    createdAt: now,
    updatedAt: now,
  }
  return { set, paths }
}

function gitOutput(args: string[], cwd: string): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

test('a linked task gets one worktree per repository on one branch, and the agent gets the repo map', async () => {
  await freshDataDir()
  const { set, paths } = await repoSetOf('app', 'lib')
  const docs = await project()
  await writeFile(join(docs, 'README.md'), 'docs\n', 'utf-8')
  gitRepo(docs)

  // Work in progress in the user's lib checkout stays there, and lib is marked.
  await writeFile(join(paths.lib, 'wip.txt'), 'not committed\n', 'utf-8')

  await withManager(async (mgr) => {
    const task = await mgr.createLinkedTaskWorkspace(set, { setId: set.id, mode: 'isolated', name: 'Rename API' })
    const [app, lib] = task.linkedTask!.repos
    assert.equal(task.kind, 'repoSet')
    assert.equal(app.sourceWasDirty, undefined)
    assert.equal(lib.sourceWasDirty, true)
    assert.equal(existsSync(join(lib.workPath, 'wip.txt')), false)
    assert.equal(task.path, app.workPath, 'the agent starts in the main repository')
    assert.equal(app.branch, lib.branch)
    assert.equal(gitOutput(['branch', '--show-current'], app.workPath), app.branch)
    assert.equal(gitOutput(['branch', '--show-current'], lib.workPath), app.branch)
    assert.equal(gitOutput(['branch', '--show-current'], paths.app) !== app.branch, true, 'the user checkout keeps its branch')

    // The panels follow the focused repository.
    assert.equal(mgr.getPanelRoot(task.id), app.workPath)
    mgr.focusLinkedRepo(task.id, 'lib')
    assert.equal(mgr.getPanelRoot(task.id), lib.workPath)
    assert.throws(() => mgr.focusLinkedRepo(task.id, 'nope'), /not in this task/)

    // A repository added during the task gets the same branch and reaches the repo map.
    const added = await mgr.addRepoToLinkedTask(task.id, docs)
    const docsRepo = added.linkedTask!.repos[2]
    assert.equal(docsRepo.role, 'linked')
    assert.equal(docsRepo.name, basename(docs), 'an added repository takes its folder name')
    assert.equal(gitOutput(['branch', '--show-current'], docsRepo.workPath), app.branch)
    await assert.rejects(mgr.addRepoToLinkedTask(task.id, docs), /already in the task/)
    const mapPath = getGuiDataPath(join('repo-maps', `${task.id}.json`))
    const map = parseRepoMap(JSON.parse(await readFile(mapPath, 'utf-8')))
    assert.deepEqual(map?.repos.map((repo) => [repo.name, repo.role, repo.workPath]), [
      ['app', 'main', app.workPath], ['lib', 'linked', lib.workPath], [docsRepo.name, 'linked', docsRepo.workPath],
    ])

    // Every agent start of the tab loads the extension and points it at the map.
    await mgr.setActiveWorkspace(task.id)
    const { runtime, process: agent } = await liveRuntime(mgr, task.id, 701, 'stopped')
    await mgr.startSessionRuntime(runtime.runtimeId)
    const args = agent.lastStartOptions?.args ?? []
    assert.equal(args[args.indexOf('-e') + 1], join(TEST_RESOURCES_DIR, 'pi-desktop-repo-set.ts'))
    assert.equal(agent.lastStartOptions?.env?.[REPO_MAP_ENV], mapPath)
    assert.equal(agent.lastStartOptions?.cwd, app.workPath)

    // A tab of a linked task keeps its folders.
    await assert.rejects(mgr.changeWorkspacePath(task.id, await project()), /keeps the folders/)

    // The task survives a restart of the app.
    const reopened = new WorkspaceManager()
    await reopened.initialize()
    assert.equal(reopened.getWorkspaces().find((item) => item.id === task.id)?.linkedTask?.repos.length, 3)
    reopened.stopAll()

    // Closing removes the clean worktrees and keeps the one with changes.
    await writeFile(join(lib.workPath, 'edit.txt'), 'work in progress\n', 'utf-8')
    const result = await mgr.removeWorkspace(task.id)
    assert.deepEqual(result.preservedWorktreePaths, [lib.workPath])
    assert.equal(existsSync(app.workPath), false)
    assert.equal(existsSync(docsRepo.workPath), false)
    assert.equal(existsSync(lib.workPath), true)
    assert.equal(existsSync(mapPath), false)
  })
})

test('a linked task that cannot prepare one repository undoes the worktrees it already made', async () => {
  await freshDataDir()
  const { set, paths } = await repoSetOf('app', 'lib')
  const broken: RepoSet = {
    ...set,
    members: [...set.members, { name: 'broken', sourcePath: await project(), role: 'linked' }],
  }

  await withManager(async (mgr) => {
    await assert.rejects(mgr.createLinkedTaskWorkspace(broken, { setId: set.id, mode: 'isolated' }), /Could not prepare "broken"/)
    assert.equal(mgr.getWorkspaces().length, 0)
    for (const path of [paths.app, paths.lib]) {
      assert.equal(gitOutput(['worktree', 'list', '--porcelain'], path).split('\n').filter((line) => line.startsWith('worktree ')).length, 1)
      assert.equal(gitOutput(['branch', '--list', 'pi/*'], path), '', 'the new branch is deleted too')
    }
  })
})

test('an in-place linked task edits the user checkouts and never removes them', async () => {
  await freshDataDir()
  const { set, paths } = await repoSetOf('app', 'lib')

  await withManager(async (mgr) => {
    const task = await mgr.createLinkedTaskWorkspace(set, { setId: set.id, mode: 'inPlace' })
    assert.equal(task.name, 'Shop', 'the set name is the default task name')
    assert.equal(task.path, paths.app)
    assert.deepEqual(task.linkedTask!.repos.map((repo) => [repo.workPath, repo.managed]), [[paths.app, false], [paths.lib, false]])
    assert.equal(task.linkedTask!.repos[0].branch, gitOutput(['branch', '--show-current'], paths.app))

    const result = await mgr.removeWorkspace(task.id)
    assert.equal(result.preservedWorktreePaths, undefined)
    assert.equal(existsSync(paths.app), true)
    assert.equal(existsSync(paths.lib), true)
  })
})

test('background session opening reuses one writer without changing main workspace or runtime', async () => {
  await freshDataDir()
  await withManager(async (mgr) => {
    const alpha = await mgr.createWorkspace('Alpha', await project())
    const beta = await mgr.createWorkspace('Beta', await project())
    const main = await mgr.createNewSessionRuntime(beta.id)
    const sessionPath = join(await project(), 'saved.jsonl')
    await writeFile(sessionPath, JSON.stringify({ type: 'session', id: 'saved' }) + '\n')
    const background = mgr.openSessionRuntime(alpha.id, sessionPath)
    const manager = mgr.getSessionRuntimeManager(background.runtimeId)
    assert.ok(manager)
    assert.equal(background.active, false)
    assert.equal(mgr.getActiveWorkspaceId(), beta.id)
    assert.equal(mgr.getActiveSessionRuntime()?.runtimeId, main.runtimeId)
    assert.equal(mgr.getWorkspaceSessionRuntime(alpha.id), null, 'background views do not replace the project main selection')
    assert.equal(mgr.openSessionRuntime(alpha.id, sessionPath).runtimeId, background.runtimeId)
    assert.equal(mgr.getSessionRuntimeManager(background.runtimeId), manager)
    assert.throws(() => mgr.openSessionRuntime(beta.id, sessionPath), /different workspace/)
  })
})

test('view references protect empty tabs from pruning but explicit close still invalidates them', async () => {
  await freshDataDir()
  await withManager(async (mgr) => {
    const ws = await mgr.createWorkspace('Project', await project())
    const sessionPath = join(await project(), 'empty.jsonl')
    await writeFile(sessionPath, JSON.stringify({ type: 'session', id: 'empty' }) + '\n')
    const runtime = mgr.openSessionRuntime(ws.id, sessionPath)
    const release = mgr.retainSessionRuntime(runtime.runtimeId)
    assert.deepEqual(await mgr.pruneEmptySessionRuntimes(), [])
    assert.ok(mgr.getSessionRuntime(runtime.runtimeId))
    const result = await mgr.closeSessionRuntime(runtime.runtimeId)
    assert.equal(result?.runtimeId, runtime.runtimeId)
    assert.equal(mgr.getSessionRuntime(runtime.runtimeId), null)
    release()
    release()
    const reopened = mgr.openSessionRuntime(ws.id, sessionPath)
    const releaseAgain = mgr.retainSessionRuntime(reopened.runtimeId)
    releaseAgain()
    assert.equal((await mgr.pruneEmptySessionRuntimes())[0]?.runtimeId, reopened.runtimeId)
  })
})

test('a referenced popup runtime remains eligible for idle process eviction and can resume its same file', async () => {
  await freshDataDir()
  await withManager(async (mgr) => {
    const ws = await mgr.createWorkspace('Project', await project())
    const sessionPath = join(await project(), 'saved.jsonl')
    await writeFile(sessionPath, JSON.stringify({ type: 'session', id: 'saved' }) + '\n')
    const runtime = mgr.openSessionRuntime(ws.id, sessionPath)
    const manager = mgr.getSessionRuntimeManager(runtime.runtimeId)!
    const process = fakePiProcess(manager, 8000)
    reportsSessionFile(manager, sessionPath, 'saved')
    const release = mgr.retainSessionRuntime(runtime.runtimeId)
    for (let index = 0; index < MAX_LIVE_SESSION_RUNTIMES; index++) {
      await liveRuntime(mgr, ws.id, 8100 + index)
    }
    assert.equal(process.stopped, true, 'a view reference is not a live-process-budget exemption')
    assert.equal(mgr.getSessionRuntime(runtime.runtimeId)?.sessionPath, sessionPath)
    const main = mgr.getActiveSessionRuntime()
    await mgr.startSessionRuntime(runtime.runtimeId)
    assert.equal(process.starts, 1)
    assert.equal(process.lastStartOptions?.sessionPath, sessionPath)
    assert.equal(mgr.getActiveSessionRuntime()?.runtimeId, main?.runtimeId)
    assert.equal(liveRuntimeCount(mgr), MAX_LIVE_SESSION_RUNTIMES)
    release()
  })
})

test('background project selection preserves an empty main selection and persists without automatic activation', async () => {
  await freshDataDir()
  await withManager(async (mgr) => {
    const path = await project()
    const workspace = await mgr.createWorkspace('Quick task', path, { activate: false })
    assert.equal(mgr.getActiveWorkspace(), null)
    assert.equal(mgr.getActiveSessionRuntime(), null)
    assert.deepEqual(mgr.getSessionRuntimes(), [])
    const duplicate = await mgr.createWorkspace('Same folder', path, { activate: false })
    assert.equal(duplicate.id, workspace.id)
    assert.equal(mgr.getActiveWorkspace(), null)
    const persisted = JSON.parse(await readFile(getGuiDataPath('workspaces.json'), 'utf-8'))
    assert.equal(persisted.activeWorkspaceId, null)
    assert.deepEqual(persisted.workspaces.map((item: { id: string }) => item.id), [workspace.id])
  })
})

test('inactive quick-task creation leaves the main and per-workspace active runtimes unchanged', async () => {
  await freshDataDir()
  await withManager(async (mgr) => {
    const target = await mgr.createWorkspace('Target', await project(), { activate: false })
    const main = await mgr.createWorkspace('Main', await project())
    const mainRuntime = await mgr.createNewSessionRuntime(main.id)
    const first = mgr.createInactiveSessionRuntime(target.id)
    const second = mgr.createInactiveSessionRuntime(target.id)
    assert.notEqual(first.runtimeId, second.runtimeId)
    assert.equal(first.status, 'stopped')
    assert.equal(first.pid, null)
    assert.equal(first.sessionPath, null)
    assert.equal(first.active, false)
    assert.equal(mgr.getSessionRuntimeManager(first.runtimeId)?.getStatus().status, 'stopped')
    assert.equal(mgr.getActiveWorkspace()?.id, main.id)
    assert.equal(mgr.getActiveSessionRuntime()?.runtimeId, mainRuntime.runtimeId)
    assert.equal(mgr.getWorkspaceSessionRuntime(target.id), null)
  })
})

test('allocating an inactive task does not evict a process from a full live-runtime budget', async () => {
  await freshDataDir()
  await withManager(async (mgr) => {
    const workspace = await mgr.createWorkspace('Budget', await project())
    const live: FakePiProcess[] = []
    for (let index = 0; index < MAX_LIVE_SESSION_RUNTIMES; index++) {
      live.push((await liveRuntime(mgr, workspace.id, 19000 + index)).process)
    }
    const active = mgr.getActiveSessionRuntime()?.runtimeId
    mgr.createInactiveSessionRuntime(workspace.id)
    assert.equal(liveRuntimeCount(mgr), MAX_LIVE_SESSION_RUNTIMES)
    assert.equal(live.some((process) => process.stopped), false)
    assert.equal(mgr.getActiveSessionRuntime()?.runtimeId, active)
  })
})

test('opening saved history preserves the live budget until its runtime starts', async () => {
  await freshDataDir()
  await withManager(async (mgr) => {
    const workspace = await mgr.createWorkspace('Budget', await project())
    const live: FakePiProcess[] = []
    for (let index = 0; index < MAX_LIVE_SESSION_RUNTIMES; index++) {
      live.push((await liveRuntime(mgr, workspace.id, 20000 + index)).process)
    }
    const active = mgr.getActiveSessionRuntime()?.runtimeId
    const sessionPath = join(await project(), 'saved.jsonl')
    await writeFile(sessionPath, JSON.stringify({ type: 'session', id: 'saved' }) + '\n')

    const opened = mgr.openSessionRuntime(workspace.id, sessionPath)
    assert.equal(opened.status, 'stopped')
    assert.equal(opened.pid, null)
    assert.equal(liveRuntimeCount(mgr), MAX_LIVE_SESSION_RUNTIMES)
    assert.equal(live.some((process) => process.stopped), false)
    assert.equal(mgr.getActiveSessionRuntime()?.runtimeId, active)

    const manager = mgr.getSessionRuntimeManager(opened.runtimeId)!
    const started = fakePiProcess(manager, 21000, 'stopped')
    reportsSessionFile(manager, sessionPath, 'saved')
    await mgr.startSessionRuntime(opened.runtimeId)

    assert.equal(started.starts, 1)
    assert.equal(started.lastStartOptions?.sessionPath, sessionPath)
    assert.equal(live.filter((process) => process.stopped).length, 1)
    assert.equal(live.at(-1)?.stopped, false, 'the active main session is never evicted')
    assert.equal(liveRuntimeCount(mgr), MAX_LIVE_SESSION_RUNTIMES)
    assert.equal(mgr.getActiveSessionRuntime()?.runtimeId, active)
  })
})
