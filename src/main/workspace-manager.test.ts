import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, readFile, writeFile, access } from 'fs/promises'
import { existsSync } from 'fs'
import { spawnSync } from 'child_process'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import type {
  PiProcessStatus,
  PiStartOptions,
  SessionRuntimeCloseResult,
  SessionRuntimeInfo,
} from '../shared/ipc-contracts'
import { configureGuiDataDir, getGuiDataPath } from './app-data-paths'
import { isPathWithin } from './path-authorization'
import { getOmpSessionsRoot, getSessionsRoot } from './pi-paths'
import { PiRpcManager } from './pi-rpc-manager'
import { isDisposableSessionFile, MAX_LIVE_SESSION_RUNTIMES, WorkspaceManager } from './workspace-manager'

async function freshDataDir(): Promise<void> {
  configureGuiDataDir(await mkdtemp(join(tmpdir(), 'pi-ws-')))
}

async function project(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'pi-proj-'))
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
  await freshDataDir()
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

    assert.equal(adopted.path.replaceAll('\\', '/'), leftover.replaceAll('\\', '/'))
    assert.equal(adopted.branch, 'feature/existing')
    assert.equal(adopted.managed, false)
    const result = await mgr.removeWorkspace(adopted.id)
    assert.equal(result.worktreeRemoved, undefined)
    assert.equal(existsSync(leftover), true)
  })

  git(['worktree', 'remove', leftover])
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
