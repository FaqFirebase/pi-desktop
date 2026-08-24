import { dirname, basename, resolve } from 'path'
import { readFile, writeFile, mkdir, rename, copyFile } from 'fs/promises'
import { existsSync } from 'fs'
import { PiRpcManager } from './pi-rpc-manager'
import { FileService } from './file-service'
import type {
  FileChangeEvent,
  PiStartOptions,
  WorkspaceRemoveResult,
  WorkspaceTabOptions,
  SessionRuntimeInfo,
  SessionRuntimeActivity,
  SessionRuntimeCloseResult,
} from '../shared/ipc-contracts'
import { getGuiDataPath } from './app-data-paths'
import { engineForBoundSession, isWithinSessionRoots } from './pi-paths'
import { pathsEqual, pathGroupKey } from './session-paths'
import { isPathWithin } from './path-authorization'
import { appLog } from './app-log'
import { inspectSessionContent } from './session-metadata'
import {
  createGitWorktree,
  inspectGitRepository,
  listGitWorktrees,
  removeGitWorktree,
  slugifyWorktreePart,
  worktreeBranchName,
  worktreeTargetPath,
} from './git-worktree'
import { extractGitHubPullRequestUrl, resolvePullRequestHeadBranch } from './git-conveyor'

/**
 * Manages project workspaces and their independent Pi session runtimes.
 * Multiple runtimes may share one workspace directory; the workspace list is
 * persisted, while live runtime processes are intentionally in-memory.
 *
 * Persistence: workspace list stored in the Electron userData directory.
 */

const WORKSPACES_FILE = 'workspaces.json'

/**
 * Directory under the GUI data path holding every worktree this app creates.
 * It is also the only place a task may reuse a checkout from: everything
 * outside it — the user's clone above all — belongs to the user.
 */
const MANAGED_WORKTREES_DIR = 'worktrees'

/**
 * How many session runtimes may own a live Pi child process at the same time.
 * Every runtime is a full agent process, so without a bound the app leaks one
 * process per session the user ever opens, until it quits. The active session
 * plus a small recently-used set keeps tab switching instant while capping
 * memory; an evicted tab stays open and spawns a fresh process when selected
 * again, because its session lives on disk and not in the process.
 */
export const MAX_LIVE_SESSION_RUNTIMES = 6

export interface Workspace {
  id: string
  name: string
  path: string
  createdAt: number
  lastActiveAt: number
  color: string
  /** Optional on disk for backward compatibility with older workspace files. */
  kind?: 'folder' | 'worktree'
  repoRoot?: string
  branch?: string
  baseRef?: string
  sourceWasDirty?: boolean
  /** False for an existing user worktree adopted by the app; never delete it on close. */
  managed?: boolean
  /** Original task text when the app created or adopted this worktree. */
  taskPrompt?: string
}

interface WorkspaceState {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
}

const WORKSPACE_COLORS = [
  '#3b82f6', '#ef4444', '#22c55e', '#eab308', '#a855f7',
  '#ec4899', '#06b6d4', '#f97316', '#6366f1', '#14b8a6',
]

export type PiManagerListener = (manager: PiRpcManager) => void
export type ActiveWorkspaceListener = (workspaceId: string | null) => void
export type FileChangeListener = (event: FileChangeEvent) => void
export type WorkspaceRemovedListener = (workspaceId: string) => void
export type SessionRuntimeListener = (runtime: SessionRuntimeInfo) => void

interface SessionRuntimeEntry {
  info: SessionRuntimeInfo
  manager: PiRpcManager
  /**
   * Wall clock of the last time this runtime was used (created, activated,
   * started, commanded, or changed activity). Drives least-recently-active
   * eviction; kept off SessionRuntimeInfo because the renderer never needs it.
   */
  lastActiveAt: number
  /**
   * True while every session file this runtime has ever pointed at was written
   * by the child process we spawned for it. Set when the tab is opened with no
   * session, cleared the moment a start binds it to a file that already exists
   * on disk. It is the one thing that makes a close-time delete safe — see
   * isDisposableSessionFile.
   */
  appCreated: boolean
}

/**
 * The ONLY condition under which this app deletes a session file the user never
 * asked it to delete. Every clause has to hold:
 *
 *  - `appCreated`: the file was written by an agent this app spawned during
 *    this run, for a tab that started with no session. A file that already
 *    existed — opened from the list, forked, or resumed with --continue — is
 *    the user's conversation and is never auto-deleted, whatever it looks like
 *    on disk.
 *  - `empty`: the close-time read PROVED it header-only. `unknown` (an
 *    unreadable or partial read) is not empty and never reaches here.
 *  - inside a session store, and still present.
 *
 * Deletion is permanent when `trash` is missing, so reading as empty is on its
 * own never a reason to remove anything: leaving a junk file behind costs
 * nothing, losing a conversation cannot be undone.
 */
export function isDisposableSessionFile(
  result: SessionRuntimeCloseResult
): result is SessionRuntimeCloseResult & { sessionPath: string } {
  return (
    result.appCreated &&
    result.empty &&
    result.sessionPath !== null &&
    isWithinSessionRoots(result.sessionPath) &&
    existsSync(result.sessionPath)
  )
}

export class WorkspaceManager {
  private workspaces: Workspace[] = []
  private activeWorkspaceId: string | null = null
  private piManagers = new Map<string, PiRpcManager>()
  private fileServices = new Map<string, FileService>()
  // A workspace is a project container. Each live session gets its own Pi
  // process, even when several sessions share the same workspace cwd.
  private sessionRuntimes = new Map<string, SessionRuntimeEntry>()
  private runtimeBySessionPath = new Map<string, string>()
  private activeRuntimeByWorkspace = new Map<string, string>()
  private activeRuntimeId: string | null = null
  private sessionRuntimeListeners: SessionRuntimeListener[] = []
  private configPath: string
  private nextColorIndex = 0
  private piManagerListeners: PiManagerListener[] = []
  // Track which (manager, listener) pairs are already wired so we never call
  // the same listener twice for the same manager. Using a WeakSet keyed on
  // the manager alone (the old design) was buggy: a manager that was created
  // BEFORE any listeners were registered would be marked "wired" and never
  // get the listeners that arrived later — silently dropping every Pi event
  // for managers loaded from disk during `initialize()`.
  private wiredPairs = new WeakMap<PiRpcManager, Set<PiManagerListener>>()
  private activeWorkspaceListeners: ActiveWorkspaceListener[] = []
  private fileChangeListeners: FileChangeListener[] = []
  private workspaceRemovedListeners: WorkspaceRemovedListener[] = []
  // The workspace whose FileService currently has an active disk watcher.
  // Only the active workspace is watched, mirroring how Pi events are
  // forwarded for the active workspace only.
  private watchingWorkspaceId: string | null = null

  constructor() {
    this.configPath = getGuiDataPath(WORKSPACES_FILE)
  }

  onFileChange(listener: FileChangeListener): void {
    this.fileChangeListeners.push(listener)
  }

  onWorkspaceRemoved(listener: WorkspaceRemovedListener): void {
    this.workspaceRemovedListeners.push(listener)
  }

  private emitFileChange(event: FileChangeEvent): void {
    for (const listener of this.fileChangeListeners) {
      listener(event)
    }
  }

  /**
   * Ensure the disk watcher is attached to the active workspace's FileService
   * (and detached from any previously-watched one). Called on startup and on
   * every active-workspace change.
   */
  private updateActiveWatcher(): void {
    if (this.watchingWorkspaceId === this.activeWorkspaceId) return

    if (this.watchingWorkspaceId) {
      this.fileServices.get(this.watchingWorkspaceId)?.stopWatching()
    }

    this.watchingWorkspaceId = this.activeWorkspaceId
    if (this.activeWorkspaceId) {
      this.fileServices
        .get(this.activeWorkspaceId)
        ?.startWatching((event) => this.emitFileChange(event))
    }
  }

  onPiManager(listener: PiManagerListener): void {
    this.piManagerListeners.push(listener)
    // Attach this NEW listener to every existing manager (subject to the
    // per-pair dedup below). This is what makes late-registered listeners
    // (e.g. the IPC broadcaster, which registers after workspaces have been
    // loaded from disk) actually receive events.
    for (const manager of this.piManagers.values()) {
      this.attachListenerOnce(manager, listener)
    }
    for (const entry of this.sessionRuntimes.values()) {
      this.attachListenerOnce(entry.manager, listener)
    }
  }

  onActiveWorkspaceChanged(listener: ActiveWorkspaceListener): void {
    this.activeWorkspaceListeners.push(listener)
  }

  private emitActiveWorkspaceChanged(): void {
    this.updateActiveWatcher()
    for (const listener of this.activeWorkspaceListeners) {
      listener(this.activeWorkspaceId)
    }
  }

  /**
   * Wire all currently-registered listeners to a manager (called when a
   * new manager is created). Per-pair dedup ensures a listener doesn't
   * get attached twice if `wirePiManager` is called more than once for
   * the same manager (e.g. createWorkspace + later startPiForWorkspace).
   */
  private wirePiManager(manager: PiRpcManager): void {
    for (const listener of this.piManagerListeners) {
      this.attachListenerOnce(manager, listener)
    }
  }

  private attachListenerOnce(manager: PiRpcManager, listener: PiManagerListener): void {
    let attached = this.wiredPairs.get(manager)
    if (!attached) {
      attached = new Set()
      this.wiredPairs.set(manager, attached)
    }
    if (attached.has(listener)) return
    attached.add(listener)
    listener(manager)
  }

  onSessionRuntime(listener: SessionRuntimeListener): void {
    this.sessionRuntimeListeners.push(listener)
    for (const entry of this.sessionRuntimes.values()) listener(this.snapshotRuntime(entry))
  }

  private snapshotRuntime(entry: SessionRuntimeEntry): SessionRuntimeInfo {
    return {
      ...entry.info,
      ...entry.manager.getStatus(),
      active: entry.info.runtimeId === this.activeRuntimeId,
    }
  }

  private emitSessionRuntime(entry: SessionRuntimeEntry): void {
    const snapshot = this.snapshotRuntime(entry)
    entry.info = { ...entry.info, ...snapshot }
    for (const listener of this.sessionRuntimeListeners) listener(snapshot)
  }

  private emitRuntimeActivity(entry: SessionRuntimeEntry, activity: SessionRuntimeActivity | null): void {
    if (entry.info.activity === activity) return
    this.touchRuntime(entry)
    entry.info = { ...entry.info, activity }
    this.emitSessionRuntime(entry)
  }

  /** Mark a runtime as recently used so eviction picks a genuinely idle one. */
  private touchRuntime(entry: SessionRuntimeEntry): void {
    entry.lastActiveAt = Date.now()
  }

  /** A runtime owns a Pi child process only while it is starting or running. */
  private isRuntimeLive(entry: SessionRuntimeEntry): boolean {
    const { status } = entry.manager.getStatus()
    return status === 'starting' || status === 'running'
  }

  /** The open runtime that currently owns a session file, if there is one. */
  private runtimeOwningSessionPath(sessionPath: string): SessionRuntimeEntry | null {
    const ownerId = this.runtimeBySessionPath.get(pathGroupKey(sessionPath))
    if (!ownerId) return null
    return this.sessionRuntimes.get(ownerId) ?? null
  }

  /**
   * Stop background runtimes until one more live process fits within
   * MAX_LIVE_SESSION_RUNTIMES. Only the process is stopped: the tab stays open
   * and its session file stays on disk, so selecting the tab again starts a
   * fresh Pi on the same session.
   *
   * Never evicted: the incoming runtime, the active one, one that is still
   * starting, and one mid-turn ('working' or 'needs-approval'). When every
   * remaining runtime is protected the budget is deliberately exceeded —
   * killing a turn the user is waiting on is worse than one extra process.
   */
  private enforceLiveRuntimeBudget(incomingRuntimeId: string | null): void {
    const evictable = (entry: SessionRuntimeEntry): boolean =>
      entry.info.runtimeId !== incomingRuntimeId &&
      entry.info.runtimeId !== this.activeRuntimeId &&
      entry.info.activity !== 'working' &&
      entry.info.activity !== 'needs-approval' &&
      // 'running' rules out both a stopped runtime, which frees nothing, and a
      // starting one, whose caller is still awaiting readiness.
      entry.manager.getStatus().status === 'running'

    let live = [...this.sessionRuntimes.values()].filter(
      (entry) => entry.info.runtimeId !== incomingRuntimeId && this.isRuntimeLive(entry)
    ).length

    while (live >= MAX_LIVE_SESSION_RUNTIMES) {
      let victim: SessionRuntimeEntry | null = null
      for (const entry of this.sessionRuntimes.values()) {
        if (!evictable(entry)) continue
        // Map iteration follows creation order, so a strict `<` breaks
        // same-millisecond ties in favour of the longest-open tab.
        if (!victim || entry.lastActiveAt < victim.lastActiveAt) victim = entry
      }
      if (!victim) return
      appLog.info(
        'workspaces',
        `Stopped idle session runtime ${victim.info.runtimeId} to stay within ${MAX_LIVE_SESSION_RUNTIMES} live Pi processes`
      )
      // stopSessionRuntime emits the runtime snapshot, so the renderer marks
      // the tab stopped instead of showing a process that no longer exists.
      this.stopSessionRuntime(victim.info.runtimeId)
      live -= 1
    }
  }

  private attachSessionRuntime(entry: SessionRuntimeEntry): void {
    const { manager } = entry
    manager.on('status-change', () => {
      entry.info = { ...entry.info, ...manager.getStatus() }
      if (entry.info.status === 'running' && entry.info.activity === 'failed') {
        entry.info = { ...entry.info, activity: null }
      }
      this.emitSessionRuntime(entry)
    })
    manager.on('agent_start', () => this.emitRuntimeActivity(entry, 'working'))
    manager.on('agent_end', () => this.emitRuntimeActivity(entry, 'completed'))
    manager.on('extension_ui_request', (event: { method?: string }) => {
      if (event.method === 'select' || event.method === 'confirm' || event.method === 'input' || event.method === 'editor') {
        this.emitRuntimeActivity(entry, 'needs-approval')
      }
    })
    manager.on('exit', () => {
      // PiRpcManager only emits exit for an unexpected process death; deliberate
      // stop() detaches listeners first. Preserve a visible failure marker even
      // when the process died while idle.
      this.emitRuntimeActivity(entry, 'failed')
    })
  }

  private createSessionRuntime(workspaceId: string, sessionPath: string | null): SessionRuntimeEntry {
    if (sessionPath && this.runtimeOwningSessionPath(sessionPath)) {
      throw new Error('Session file is already attached to a live runtime')
    }
    // A new tab is started right after it is created, so make room for its
    // process before the tab exists.
    this.enforceLiveRuntimeBudget(null)
    const runtimeId = `rt-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    const manager = new PiRpcManager()
    const entry: SessionRuntimeEntry = {
      manager,
      lastActiveAt: Date.now(),
      // A tab opened without a session file gets one written by the agent we
      // spawn for it. A tab opened ON a file adopts a conversation that was
      // already there, which this app never gets to discard.
      appCreated: sessionPath === null,
      info: {
        runtimeId,
        workspaceId,
        sessionPath,
        sessionId: null,
        status: 'stopped',
        pid: null,
        error: null,
        activity: null,
        active: false,
      },
    }
    this.sessionRuntimes.set(runtimeId, entry)
    if (sessionPath) this.runtimeBySessionPath.set(pathGroupKey(sessionPath), runtimeId)
    this.wirePiManager(manager)
    this.attachSessionRuntime(entry)
    this.emitSessionRuntime(entry)
    return entry
  }

  private setActiveRuntime(workspaceId: string, runtimeId: string | null): void {
    const previous = this.activeRuntimeId
    if (runtimeId) this.activeRuntimeByWorkspace.set(workspaceId, runtimeId)
    else this.activeRuntimeByWorkspace.delete(workspaceId)
    this.activeRuntimeId = this.activeWorkspaceId === workspaceId ? runtimeId : this.activeRuntimeId
    if (previous && previous !== this.activeRuntimeId) {
      const old = this.sessionRuntimes.get(previous)
      if (old) this.emitSessionRuntime(old)
    }
    if (this.activeRuntimeId) {
      const next = this.sessionRuntimes.get(this.activeRuntimeId)
      if (next) {
        this.touchRuntime(next)
        this.emitSessionRuntime(next)
      }
    }
  }

  getSessionRuntimes(workspaceId?: string): SessionRuntimeInfo[] {
    return [...this.sessionRuntimes.values()]
      .filter((entry) => workspaceId === undefined || entry.info.workspaceId === workspaceId)
      .map((entry) => this.snapshotRuntime(entry))
  }

  /** Drop inactive header-only sessions so abandoned New Session tabs do not linger. */
  async pruneEmptySessionRuntimes(): Promise<SessionRuntimeCloseResult[]> {
    const candidates = [...this.sessionRuntimes.values()]
      .filter((entry) =>
        entry.info.runtimeId !== this.activeRuntimeId &&
        entry.info.sessionPath &&
        entry.info.activity === null &&
        entry.manager.getStatus().status !== 'starting'
      )
    const closed: SessionRuntimeCloseResult[] = []
    for (const entry of candidates) {
      if (await inspectSessionContent(entry.info.sessionPath!) !== 'empty') continue
      // A candidate may have become active or started work while the bounded
      // file scan was in flight. Re-check before stopping it.
      const current = this.sessionRuntimes.get(entry.info.runtimeId)
      if (
        !current ||
        current.info.runtimeId === this.activeRuntimeId ||
        current.info.activity !== null ||
        current.manager.getStatus().status === 'starting'
      ) continue
      const result = await this.closeSessionRuntime(entry.info.runtimeId)
      if (result) closed.push(result)
    }
    return closed
  }

  getActiveSessionRuntime(): SessionRuntimeInfo | null {
    if (!this.activeRuntimeId) return null
    const entry = this.sessionRuntimes.get(this.activeRuntimeId)
    return entry ? this.snapshotRuntime(entry) : null
  }

  getSessionRuntime(runtimeId: string): SessionRuntimeInfo | null {
    const entry = this.sessionRuntimes.get(runtimeId)
    return entry ? this.snapshotRuntime(entry) : null
  }

  getSessionRuntimeForPath(sessionPath: string): SessionRuntimeInfo | null {
    const runtimeId = this.runtimeBySessionPath.get(pathGroupKey(sessionPath))
    return runtimeId ? this.getSessionRuntime(runtimeId) : null
  }

  runtimeIdFor(manager: PiRpcManager): string | null {
    for (const [runtimeId, entry] of this.sessionRuntimes) {
      if (entry.manager === manager) return runtimeId
    }
    return this.workspaceIdFor(manager)
  }
  setSessionRuntimeActivity(runtimeId: string, activity: SessionRuntimeActivity | null): void {
    const entry = this.sessionRuntimes.get(runtimeId)
    if (entry) this.emitRuntimeActivity(entry, activity)
  }

  sessionPathFor(manager: PiRpcManager): string | null {
    for (const entry of this.sessionRuntimes.values()) {
      if (entry.manager === manager) return entry.info.sessionPath
    }
    return null
  }

  /** Activate a session without waiting for Pi startup. */
  async activateSession(workspaceId: string, sessionPath: string): Promise<SessionRuntimeInfo> {
    const workspace = this.workspaces.find((item) => item.id === workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    if (this.activeWorkspaceId !== workspaceId) await this.setActiveWorkspace(workspaceId)
    const key = pathGroupKey(sessionPath)
    let runtimeId = this.runtimeBySessionPath.get(key)
    let entry = runtimeId ? this.sessionRuntimes.get(runtimeId) : undefined
    if (entry && entry.info.workspaceId !== workspaceId) {
      throw new Error('Session is already attached to a different workspace runtime')
    }
    if (!entry) entry = this.createSessionRuntime(workspaceId, sessionPath)
    runtimeId = entry.info.runtimeId
    this.setActiveRuntime(workspaceId, runtimeId)
    this.emitSessionRuntime(entry)
    return this.snapshotRuntime(entry)
  }

  /** Create an empty session runtime and make it active immediately. */
  async createNewSessionRuntime(workspaceId: string): Promise<SessionRuntimeInfo> {
    const workspace = this.workspaces.find((item) => item.id === workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    if (this.activeWorkspaceId !== workspaceId) await this.setActiveWorkspace(workspaceId)
    const entry = this.createSessionRuntime(workspaceId, null)
    this.setActiveRuntime(workspaceId, entry.info.runtimeId)
    return this.snapshotRuntime(entry)
  }

  async startSessionRuntime(runtimeId: string, options: PiStartOptions = {}): Promise<SessionRuntimeInfo> {
    const entry = this.sessionRuntimes.get(runtimeId)
    if (!entry) throw new Error(`Session runtime not found: ${runtimeId}`)
    const workspace = this.workspaces.find((item) => item.id === entry.info.workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${entry.info.workspaceId}`)
    // A start that binds this runtime to a file it did not write hands it a
    // conversation that predates us, so the file stops being ours to discard.
    // Read the caller's own options, not the merged ones: the merge re-supplies
    // the path this runtime already owns, which is still its own creation.
    const bindsExistingFile =
      options.sessionPath !== undefined ||
      options.forkSessionPath !== undefined ||
      // --continue opens "the most recent session for this cwd", which is some
      // earlier conversation. It only reaches the engine while this runtime has
      // no file of its own; once it has one, the merged --session outranks it
      // (see buildPiArgs) and the runtime re-opens what it created.
      (options.continueSession === true && entry.info.sessionPath === null)
    if (bindsExistingFile) entry.appCreated = false
    const startOptions: PiStartOptions = {
      cwd: workspace.path,
      ...(entry.info.sessionPath && !options.sessionPath && !options.forkSessionPath
        ? { sessionPath: entry.info.sessionPath }
        : {}),
      ...options,
    }
    // Start the engine that owns the session file rather than the configured
    // default: the stores are separate, so only the engine that wrote a session
    // can resume it. An engine the caller named explicitly still wins.
    const ownerEngine = engineForBoundSession(startOptions)
    if (!startOptions.engine && ownerEngine) startOptions.engine = ownerEngine
    // Re-activating an evicted tab spawns a process again, so the budget has to
    // hold here too; an already-live runtime spawns nothing and needs no room.
    if (!this.isRuntimeLive(entry)) this.enforceLiveRuntimeBudget(runtimeId)
    this.touchRuntime(entry)
    await entry.manager.start(startOptions)
    // closeSessionRuntime() can win while startup is waiting for Pi. Do not
    // emit the now-detached entry after the closed marker was broadcast.
    if (this.sessionRuntimes.get(runtimeId) !== entry) {
      return { ...entry.info, ...entry.manager.getStatus(), active: false, closed: true }
    }
    const response = await entry.manager.sendCommand({ type: 'get_state' }).catch(() => null)
    if (this.sessionRuntimes.get(runtimeId) !== entry) {
      return { ...entry.info, ...entry.manager.getStatus(), active: false, closed: true }
    }
    return this.applySessionRuntimeState(entry, response)
  }

  private applySessionRuntimeState(entry: SessionRuntimeEntry, response: unknown): SessionRuntimeInfo {
    const data = response && typeof response === 'object' && 'data' in response
      ? response.data as { sessionFile?: unknown; sessionId?: unknown }
      : undefined
    const sessionPath = typeof data?.sessionFile === 'string' ? data.sessionFile : entry.info.sessionPath
    if (sessionPath && sessionPath !== entry.info.sessionPath) {
      const owner = this.runtimeOwningSessionPath(sessionPath)
      if (owner && owner.info.runtimeId !== entry.info.runtimeId) {
        // The incumbent keeps the file — the same invariant createSessionRuntime
        // enforces up front with 'Session file is already attached to a live
        // runtime'. Leaving the mapping alone is not enough on its own: the map
        // is only an index, and two Pi processes appending to one session JSONL
        // corrupt it. Stopping the newcomer is what removes the second writer,
        // and it is the safe side to stop because the incumbent may be mid-turn.
        appLog.warn(
          'workspaces',
          `Session ${sessionPath} already belongs to runtime ${owner.info.runtimeId}; stopped runtime ${entry.info.runtimeId} instead of taking the session over`
        )
        this.stopSessionRuntime(entry.info.runtimeId)
        this.emitRuntimeActivity(entry, 'failed')
        return this.snapshotRuntime(entry)
      }
      if (entry.info.sessionPath) this.runtimeBySessionPath.delete(pathGroupKey(entry.info.sessionPath))
      this.runtimeBySessionPath.set(pathGroupKey(sessionPath), entry.info.runtimeId)
    }
    entry.info = {
      ...entry.info,
      sessionPath: sessionPath ?? null,
      sessionId: typeof data?.sessionId === 'string' ? data.sessionId : entry.info.sessionId,
      ...entry.manager.getStatus(),
    }
    this.emitSessionRuntime(entry)
    return this.snapshotRuntime(entry)
  }
  async restartSessionRuntime(runtimeId: string, options: PiStartOptions = {}): Promise<SessionRuntimeInfo> {
    const entry = this.sessionRuntimes.get(runtimeId)
    if (!entry) throw new Error(`Session runtime not found: ${runtimeId}`)
    entry.manager.stop()
    return this.startSessionRuntime(runtimeId, options)
  }

  async refreshSessionRuntime(runtimeId: string): Promise<SessionRuntimeInfo | null> {
    const entry = this.sessionRuntimes.get(runtimeId)
    if (!entry) return null
    const response = await entry.manager.sendCommand({ type: 'get_state' })
    return this.applySessionRuntimeState(entry, response)
  }

  stopSessionRuntime(runtimeId: string): void {
    const entry = this.sessionRuntimes.get(runtimeId)
    if (!entry) return
    entry.info = { ...entry.info, activity: null }
    this.emitSessionRuntime(entry)
    entry.manager.stop()
  }

  /** Close a session tab without deleting a non-empty session from disk. */
  async closeSessionRuntime(runtimeId: string): Promise<SessionRuntimeCloseResult | null> {
    const entry = this.sessionRuntimes.get(runtimeId)
    if (!entry) return null

    const { workspaceId, sessionPath } = entry.info
    const contentState = sessionPath ? await inspectSessionContent(sessionPath) : 'empty'
    // Unknown is treated as non-empty. A failed/partial metadata read must
    // never turn a real conversation into a destructive delete.
    const empty = contentState === 'empty'
    const wasActive = this.activeRuntimeId === runtimeId
    const replacementCandidates = wasActive
      ? [...this.sessionRuntimes.values()]
        .filter((candidate) => candidate.info.workspaceId === workspaceId && candidate.info.runtimeId !== runtimeId)
        .reverse()
      : []
    const replacement = replacementCandidates.find((candidate) => candidate.info.sessionPath) ?? replacementCandidates[0]

    entry.info = { ...entry.info, activity: null }
    entry.manager.stop()
    if (sessionPath) this.runtimeBySessionPath.delete(pathGroupKey(sessionPath))
    this.sessionRuntimes.delete(runtimeId)

    if (this.activeRuntimeByWorkspace.get(workspaceId) === runtimeId) {
      if (replacement) this.activeRuntimeByWorkspace.set(workspaceId, replacement.info.runtimeId)
      else this.activeRuntimeByWorkspace.delete(workspaceId)
    }
    if (wasActive) this.activeRuntimeId = replacement?.info.runtimeId ?? null

    const closed: SessionRuntimeInfo = {
      ...entry.info,
      ...entry.manager.getStatus(),
      active: false,
      activity: null,
      closed: true,
    }
    for (const listener of this.sessionRuntimeListeners) listener(closed)
    if (replacement && wasActive) this.emitSessionRuntime(replacement)

    return {
      runtimeId,
      workspaceId,
      sessionPath,
      replacementSessionPath: replacement?.info.sessionPath ?? null,
      empty,
      appCreated: entry.appCreated,
      deleted: false,
    }
  }

  sendCommandToSessionRuntime(runtimeId: string, command: Record<string, unknown>): Promise<unknown> {
    const entry = this.sessionRuntimes.get(runtimeId)
    if (!entry) return Promise.reject(new Error(`Session runtime not found: ${runtimeId}`))
    this.touchRuntime(entry)
    return entry.manager.sendCommand(command)
  }

  async initialize(): Promise<void> {
    await this.loadWorkspaces()

    // No workspace is auto-created. On a fresh install (or empty state) the app
    // opens to the home screen with no active workspace; the user opens a folder
    // or resumes a session, each of which creates + activates a workspace on
    // demand. This avoids fabricating a "Home" workspace pointed at the entire
    // home directory — unnecessary setup the user may never use, and a costly
    // recursive file watcher over the home tree (which also trips over
    // permission-protected Windows system paths).

    // Workspaces loaded from disk don't go through emitActiveWorkspaceChanged,
    // so attach the watcher to the active workspace explicitly here.
    this.updateActiveWatcher()
  }

  getWorkspaces(): Workspace[] {
    return [...this.workspaces].sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  }

  getActiveWorkspace(): Workspace | null {
    if (!this.activeWorkspaceId) return null
    return this.workspaces.find((w) => w.id === this.activeWorkspaceId) ?? null
  }

  getActiveWorkspaceId(): string | null {
    return this.activeWorkspaceId
  }

  getPiManager(workspaceId: string): PiRpcManager | null {
    const runtimeId = this.activeRuntimeByWorkspace.get(workspaceId)
    if (runtimeId) return this.sessionRuntimes.get(runtimeId)?.manager ?? null
    return this.piManagers.get(workspaceId) ?? null
  }

  getActivePiManager(): PiRpcManager | null {
    if (!this.activeWorkspaceId) return null
    return this.getPiManager(this.activeWorkspaceId)
  }

  getPiManagerForSession(workspaceId: string, sessionId: string): PiRpcManager | null {
    for (const entry of this.sessionRuntimes.values()) {
      if (entry.info.workspaceId === workspaceId && entry.info.sessionId === sessionId) return entry.manager
    }
    return null
  }

  /** Reverse lookup: the workspace id owning a given Pi manager, if any. */
  workspaceIdFor(manager: PiRpcManager): string | null {
    for (const [workspaceId, candidate] of this.piManagers) {
      if (candidate === manager) return workspaceId
    }
    for (const entry of this.sessionRuntimes.values()) {
      if (entry.manager === manager) return entry.info.workspaceId
    }
    return null
  }

  getFileService(workspaceId: string): FileService | null {
    return this.fileServices.get(workspaceId) ?? null
  }

  getActiveFileService(): FileService | null {
    if (!this.activeWorkspaceId) return null
    return this.fileServices.get(this.activeWorkspaceId) ?? null
  }

  async createWorkspace(name: string, path: string): Promise<Workspace> {
    // Check for duplicate path (case-insensitive on Windows, so "Documents"
    // and "documents" resolve to the same workspace instead of duplicating).
    const existing = this.workspaces.find((w) => pathsEqual(w.path, path))
    if (existing) {
      return this.setActiveWorkspace(existing.id)
    }

    const workspace: Workspace = {
      id: `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      path,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      color: WORKSPACE_COLORS[this.nextColorIndex % WORKSPACE_COLORS.length],
      kind: 'folder',
    }

    this.nextColorIndex++
    this.workspaces.push(workspace)

    // Create Pi manager and file service for this workspace
    const piManager = new PiRpcManager()
    this.piManagers.set(workspace.id, piManager)
    this.wirePiManager(piManager)
    const fileService = new FileService(path)
    this.fileServices.set(workspace.id, fileService)

    // Auto-set as active if it's the first workspace
    const becameActive = !this.activeWorkspaceId
    if (becameActive) {
      this.activeWorkspaceId = workspace.id
    }

    await this.saveWorkspaces()
    if (becameActive) this.emitActiveWorkspaceChanged()
    return workspace
  }

  async setActiveWorkspace(workspaceId: string): Promise<Workspace> {
    const workspace = this.workspaces.find((w) => w.id === workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)

    const changed = this.activeWorkspaceId !== workspaceId
    workspace.lastActiveAt = Date.now()
    const previousRuntimeId = this.activeRuntimeId
    this.activeWorkspaceId = workspaceId
    this.activeRuntimeId = this.activeRuntimeByWorkspace.get(workspaceId) ?? null

    await this.saveWorkspaces()
    if (changed) this.emitActiveWorkspaceChanged()
    if (previousRuntimeId && previousRuntimeId !== this.activeRuntimeId) {
      const previous = this.sessionRuntimes.get(previousRuntimeId)
      if (previous) this.emitSessionRuntime(previous)
    }
    if (this.activeRuntimeId) {
      const active = this.sessionRuntimes.get(this.activeRuntimeId)
      if (active) this.emitSessionRuntime(active)
    }
    return workspace
  }

  async removeWorkspace(workspaceId: string): Promise<WorkspaceRemoveResult> {
    const index = this.workspaces.findIndex((w) => w.id === workspaceId)
    if (index === -1) throw new Error(`Workspace not found: ${workspaceId}`)
    const workspace = this.workspaces[index]
    let worktreeRemoved: boolean | undefined
    let preservedWorktreePath: string | undefined

    // Stop Pi process and file watcher for this workspace before touching a
    // managed worktree. Git refuses dirty worktree removal, which is exactly
    // the protection we want when a tab is closed with edits still present.
    const piManager = this.piManagers.get(workspaceId)
    if (piManager) {
      await piManager.stopAndWait()
      this.piManagers.delete(workspaceId)
    }
    for (const [runtimeId, entry] of this.sessionRuntimes) {
      if (entry.info.workspaceId !== workspaceId) continue
      if (this.activeRuntimeId === runtimeId) this.activeRuntimeId = null
      await entry.manager.stopAndWait()
      if (entry.info.sessionPath) this.runtimeBySessionPath.delete(pathGroupKey(entry.info.sessionPath))
      this.sessionRuntimes.delete(runtimeId)
    }
    this.activeRuntimeByWorkspace.delete(workspaceId)
    const fileService = this.fileServices.get(workspaceId)
    if (fileService) {
      fileService.stopWatching()
      this.fileServices.delete(workspaceId)
    }
    if (workspace.kind === 'worktree' && workspace.managed !== false && workspace.repoRoot) {
      try {
        await removeGitWorktree(workspace.repoRoot, workspace.path)
        worktreeRemoved = true
      } catch (err) {
        // Keep dirty/missing worktrees on disk instead of forcing deletion.
        preservedWorktreePath = workspace.path
        appLog.warn('workspaces', 'Preserved managed worktree while closing tab', err)
      }
    }

    this.workspaces.splice(index, 1)

    // If removed workspace was active, switch to first available
    let activeChanged = false
    if (this.activeWorkspaceId === workspaceId) {
      this.activeWorkspaceId = this.workspaces.length > 0 ? this.workspaces[0].id : null
      this.activeRuntimeId = this.activeWorkspaceId
        ? this.activeRuntimeByWorkspace.get(this.activeWorkspaceId) ?? null
        : null
      activeChanged = true
    }

    await this.saveWorkspaces()
    if (activeChanged) this.emitActiveWorkspaceChanged()
    if (activeChanged && this.activeRuntimeId) {
      const active = this.sessionRuntimes.get(this.activeRuntimeId)
      if (active) this.emitSessionRuntime(active)
    }
    for (const listener of this.workspaceRemovedListeners) {
      listener(workspaceId)
    }
    return { worktreeRemoved, preservedWorktreePath }
  }

  async renameWorkspace(workspaceId: string, name: string): Promise<void> {
    const workspace = this.workspaces.find((w) => w.id === workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)

    workspace.name = name
    await this.saveWorkspaces()
  }

  /**
   * Repoint a workspace at a different folder. Replaces its FileService (which
   * binds the path at construction), stops the workspace's Pi (its cwd is
   * bound at spawn), and re-arms watching if it's the active one. The renderer
   * restarts the active workspace's Pi after this commits.
   */
  async changeWorkspacePath(workspaceId: string, newPath: string): Promise<void> {
    const workspace = this.workspaces.find((w) => w.id === workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    if (workspace.kind === 'worktree') {
      throw new Error('Managed worktree tabs cannot change folder; close the tab and create another one')
    }
    if (!existsSync(newPath)) throw new Error(`Folder does not exist: ${newPath}`)

    workspace.path = newPath
    // Pi's working directory is bound at spawn, so every session runtime must
    // stop before the project path changes. The renderer restarts the active
    // runtime after this commits; inactive sessions restart when selected.
    this.piManagers.get(workspaceId)?.stop()
    for (const entry of this.sessionRuntimes.values()) {
      if (entry.info.workspaceId === workspaceId) this.stopSessionRuntime(entry.info.runtimeId)
    }
    const oldFs = this.fileServices.get(workspaceId)
    oldFs?.stopWatching()
    this.fileServices.set(workspaceId, new FileService(newPath))
    await this.saveWorkspaces()
    // Re-arm the watcher if this is the active workspace.
    if (this.activeWorkspaceId === workspaceId) {
      this.watchingWorkspaceId = null
      this.updateActiveWatcher()
    }
  }

  /** Whether the active workspace's folder currently exists on disk. */
  activeWorkspacePathExists(): boolean {
    const ws = this.getActiveWorkspace()
    return ws ? existsSync(ws.path) : false
  }

  private async adoptExistingWorktree(
    repoRoot: string,
    entry: { path: string; head: string | null; branch: string | null },
    taskPrompt: string,
  ): Promise<Workspace> {
    const existing = this.workspaces.find((workspace) => pathsEqual(workspace.path, entry.path))
    if (existing) return existing

    const id = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const branchLabel = entry.branch?.split('/').pop() || basename(entry.path) || 'Existing worktree'
    const workspace: Workspace = {
      id,
      name: branchLabel,
      path: entry.path,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      color: WORKSPACE_COLORS[this.nextColorIndex % WORKSPACE_COLORS.length],
      kind: 'worktree',
      repoRoot,
      ...(entry.branch ? { branch: entry.branch } : {}),
      ...(entry.head ? { baseRef: entry.head } : {}),
      managed: false,
      taskPrompt,
    }
    this.nextColorIndex++
    this.workspaces.push(workspace)
    const piManager = new PiRpcManager()
    this.piManagers.set(workspace.id, piManager)
    this.wirePiManager(piManager)
    this.fileServices.set(workspace.id, new FileService(entry.path))
    await this.saveWorkspaces()
    return workspace
  }

  /** Whether a checkout lives inside the worktree root this app owns. */
  private isManagedWorktreePath(path: string): boolean {
    return isPathWithin(getGuiDataPath(MANAGED_WORKTREES_DIR), path)
  }

  /**
   * Reuse an existing checkout when the task identifies it safely. Exact task
   * metadata and a GitHub PR head branch are deterministic; a branch named in
   * the task is also accepted, but ambiguous matches are ignored.
   *
   * Only worktrees this app created are ever reusable. The UI promises that the
   * source project stays untouched, so the user's own clone — and any worktree
   * they made themselves — must never be handed to an agent, no matter which
   * branch a task names.
   */
  private async findRelatedWorktree(sourcePath: string, repoRoot: string, taskPrompt: string): Promise<Workspace | null> {
    const sourceResolved = resolve(sourcePath)
    const repoRootResolved = resolve(repoRoot)
    const normalizedTask = taskPrompt.trim().replace(/\s+/g, ' ').toLowerCase()
    if (!normalizedTask) return null

    const savedMatch = this.workspaces.find((workspace) =>
      workspace.kind === 'worktree' &&
      this.isManagedWorktreePath(workspace.path) &&
      !pathsEqual(resolve(workspace.path), sourceResolved) &&
      workspace.taskPrompt?.trim().replace(/\s+/g, ' ').toLowerCase() === normalizedTask &&
      !!workspace.repoRoot &&
      pathsEqual(workspace.repoRoot, repoRoot) &&
      existsSync(workspace.path)
    )
    if (savedMatch) return savedMatch

    let pullRequestBranch: string | null = null
    const pullRequestUrl = extractGitHubPullRequestUrl(taskPrompt)
    if (pullRequestUrl) {
      pullRequestBranch = await resolvePullRequestHeadBranch(sourcePath, pullRequestUrl).catch(() => null)
    }

    const entries = await listGitWorktrees(sourcePath).catch(() => [])
    const candidates = entries
      .filter((entry, index) =>
        // `git worktree list` prints the main working tree first. That is the
        // user's primary checkout, so drop it by position and by path.
        index > 0 &&
        !pathsEqual(resolve(entry.path), repoRootResolved) &&
        !entry.bare &&
        !pathsEqual(resolve(entry.path), sourceResolved) &&
        // Reuse is limited to the app's own worktree root; a checkout anywhere
        // else is the user's, not ours to hand over.
        this.isManagedWorktreePath(entry.path) &&
        existsSync(entry.path) &&
        entry.branch
      )
      .map((entry) => ({ ...entry, path: resolve(entry.path) }))
    const matches = candidates.filter((entry) => {
      const branch = entry.branch!
      if (pullRequestBranch) return branch === pullRequestBranch
      // Generated Pi task branches carry the slug of the first task line. A
      // branch explicitly written in the prompt is also safe when it is not a
      // generic default branch; never guess from arbitrary short words.
      const firstLineSlug = taskPrompt.split(/\r?\n/, 1)[0]?.trim().slice(0, 60)
      const generatedPrefix = firstLineSlug ? `pi/${slugifyWorktreePart(firstLineSlug)}-` : ''
      return (generatedPrefix && branch.toLowerCase().startsWith(generatedPrefix.toLowerCase())) ||
        (branch.includes('/') && normalizedTask.includes(branch.toLowerCase()))
    })
    if (matches.length !== 1) return null

    const match = matches[0]
    const existing = this.workspaces.find((workspace) => pathsEqual(workspace.path, match.path))
    return existing ?? this.adoptExistingWorktree(repoRoot, match, taskPrompt.trim())
  }

  /**
   * Create an app-owned Git worktree that becomes an independent tab, unless
   * the task already points at a related local worktree. New worktrees start
   * from HEAD; source-tab edits stay in the source tab. The workspace is not
   * activated here; the renderer performs the normal guarded tab switch.
   */
  async createWorktreeWorkspace(options: WorkspaceTabOptions = {}): Promise<Workspace> {
    const source = options.sourceWorkspaceId
      ? this.workspaces.find((w) => w.id === options.sourceWorkspaceId)
      : this.getActiveWorkspace()
    if (!source) throw new Error('No source workspace available for a new tab')
    if (!existsSync(source.path)) throw new Error(`Source folder does not exist: ${source.path}`)

    const git = await inspectGitRepository(source.path)
    const taskPrompt = options.taskPrompt?.trim() || ''
    const pullRequestUrl = extractGitHubPullRequestUrl(taskPrompt)
    if (taskPrompt) {
      const related = await this.findRelatedWorktree(source.path, git.repoRoot, taskPrompt)
      if (related) return related
    }
    if (pullRequestUrl) {
      throw new Error('The task references a GitHub pull request that is not checked out in a local worktree')
    }
    const sourceWasDirty = git.status.trim().length > 0
    const id = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const label = options.name?.trim() || `${source.name}-tab`
    const branch = worktreeBranchName(label, id)
    const targetPath = worktreeTargetPath(getGuiDataPath(MANAGED_WORKTREES_DIR), git.repoRoot, id)
    await createGitWorktree({ sourceCwd: source.path, targetPath, branch })

    const workspace: Workspace = {
      id,
      name: options.name?.trim() || `${source.name} · tab`,
      path: targetPath,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      color: WORKSPACE_COLORS[this.nextColorIndex % WORKSPACE_COLORS.length],
      kind: 'worktree',
      repoRoot: git.repoRoot,
      branch,
      baseRef: git.head,
      sourceWasDirty,
      managed: true,
      ...(taskPrompt ? { taskPrompt } : {}),
    }
    this.nextColorIndex++
    this.workspaces.push(workspace)
    const piManager = new PiRpcManager()
    this.piManagers.set(workspace.id, piManager)
    this.wirePiManager(piManager)
    this.fileServices.set(workspace.id, new FileService(targetPath))
    await this.saveWorkspaces()
    return workspace
  }

  async startPiForWorkspace(workspaceId: string, options?: PiStartOptions): Promise<void> {
    const workspace = this.workspaces.find((w) => w.id === workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)

    const runtimeId = this.activeRuntimeByWorkspace.get(workspaceId)
    let runtime = runtimeId ? this.sessionRuntimes.get(runtimeId) : undefined
    if (!runtime) {
      runtime = this.createSessionRuntime(workspaceId, options?.sessionPath ?? null)
      this.activeRuntimeByWorkspace.set(workspaceId, runtime.info.runtimeId)
      if (this.activeWorkspaceId === workspaceId) this.activeRuntimeId = runtime.info.runtimeId
    }

    await this.startSessionRuntime(runtime.info.runtimeId, {
      cwd: workspace.path,
      ...options,
    })
  }

  stopPiForWorkspace(workspaceId: string): void {
    const runtimeId = this.activeRuntimeByWorkspace.get(workspaceId)
    const runtime = runtimeId ? this.sessionRuntimes.get(runtimeId) : undefined
    if (runtime) this.stopSessionRuntime(runtimeId!)
    else this.piManagers.get(workspaceId)?.stop()
  }

  stopAll(): void {
    for (const [, manager] of this.piManagers) manager.stop()
    for (const [, entry] of this.sessionRuntimes) entry.manager.stop()
    for (const [, fs] of this.fileServices) fs.stopWatching()
    this.watchingWorkspaceId = null
    this.piManagers.clear()
    this.sessionRuntimes.clear()
    this.runtimeBySessionPath.clear()
    this.activeRuntimeByWorkspace.clear()
    this.activeRuntimeId = null
    this.fileServices.clear()
  }

  private async loadWorkspaces(): Promise<void> {
    // Prefer the live file; fall back to the .bak if the live file is missing
    // or unparseable (e.g. an external tool corrupted it).
    const state =
      (await this.readWorkspaceState(this.configPath)) ??
      (await this.readWorkspaceState(`${this.configPath}.bak`))
    if (!state) {
      this.workspaces = []
      this.activeWorkspaceId = null
      return
    }

    this.workspaces = (state.workspaces ?? []).map((workspace) => ({
      ...workspace,
      kind: workspace.kind ?? 'folder',
    }))
    this.activeWorkspaceId = state.activeWorkspaceId ?? null

    // Create file services and Pi managers for loaded workspaces
    for (const ws of this.workspaces) {
      if (!this.piManagers.has(ws.id)) {
        const manager = new PiRpcManager()
        this.piManagers.set(ws.id, manager)
        this.wirePiManager(manager)
      }
      if (!this.fileServices.has(ws.id)) {
        this.fileServices.set(ws.id, new FileService(ws.path))
      }
    }
  }

  /** Read + parse a workspace-state file, or null if missing/unparseable. */
  private async readWorkspaceState(path: string): Promise<WorkspaceState | null> {
    try {
      if (!existsSync(path)) return null
      const parsed = JSON.parse(await readFile(path, 'utf-8')) as WorkspaceState
      if (!parsed || !Array.isArray(parsed.workspaces)) return null
      return parsed
    } catch {
      return null
    }
  }

  private async saveWorkspaces(): Promise<void> {
    try {
      const dir = dirname(this.configPath)
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true })
      }

      const state: WorkspaceState = {
        workspaces: this.workspaces,
        activeWorkspaceId: this.activeWorkspaceId,
      }

      // Keep a backup of the last good file before overwriting.
      if (existsSync(this.configPath)) {
        await copyFile(this.configPath, `${this.configPath}.bak`)
      }
      // Atomic write: write a temp file then rename over the target so a crash
      // or partial write can never leave a half-written/corrupt config.
      const tmpPath = `${this.configPath}.tmp`
      await writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf-8')
      await rename(tmpPath, this.configPath)
    } catch (err) {
      console.error('Failed to save workspaces:', err)
      appLog.error('workspaces', 'Failed to save workspaces.json', err)
    }
  }
}
