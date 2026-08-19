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
} from '../shared/ipc-contracts'
import { getGuiDataPath } from './app-data-paths'
import { pathsEqual, pathGroupKey } from './session-paths'
import { appLog } from './app-log'
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
    entry.info = { ...entry.info, activity }
    this.emitSessionRuntime(entry)
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
    const runtimeId = `rt-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    const manager = new PiRpcManager()
    const entry: SessionRuntimeEntry = {
      manager,
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
      if (next) this.emitSessionRuntime(next)
    }
  }

  getSessionRuntimes(workspaceId?: string): SessionRuntimeInfo[] {
    return [...this.sessionRuntimes.values()]
      .filter((entry) => workspaceId === undefined || entry.info.workspaceId === workspaceId)
      .map((entry) => this.snapshotRuntime(entry))
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
    entry.info = { ...entry.info, activity: null }
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
    const startOptions = {
      cwd: workspace.path,
      ...(entry.info.sessionPath && !options.sessionPath && !options.forkSessionPath
        ? { sessionPath: entry.info.sessionPath }
        : {}),
      ...options,
    }
    await entry.manager.start(startOptions)
    const response = await entry.manager.sendCommand({ type: 'get_state' }).catch(() => null)
    const data = response?.data as { sessionFile?: unknown; sessionId?: unknown } | undefined
    const sessionPath = typeof data?.sessionFile === 'string' ? data.sessionFile : entry.info.sessionPath
    if (sessionPath && sessionPath !== entry.info.sessionPath) {
      if (entry.info.sessionPath) this.runtimeBySessionPath.delete(pathGroupKey(entry.info.sessionPath))
      this.runtimeBySessionPath.set(pathGroupKey(sessionPath), runtimeId)
    }
    entry.info = {
      ...entry.info,
      sessionPath: sessionPath ?? null,
      sessionId: typeof data?.sessionId === 'string' ? data.sessionId : entry.info.sessionId,
      activity: null,
      ...entry.manager.getStatus(),
    }
    this.emitSessionRuntime(entry)
    return this.snapshotRuntime(entry)
  }

  stopSessionRuntime(runtimeId: string): void {
    const entry = this.sessionRuntimes.get(runtimeId)
    if (!entry) return
    entry.info = { ...entry.info, activity: null }
    this.emitSessionRuntime(entry)
    entry.manager.stop()
  }

  sendCommandToSessionRuntime(runtimeId: string, command: Record<string, unknown>): Promise<unknown> {
    const entry = this.sessionRuntimes.get(runtimeId)
    if (!entry) return Promise.reject(new Error(`Session runtime not found: ${runtimeId}`))
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

  getPiManagerForSession(workspaceId: string, sessionId?: string): PiRpcManager | null {
    if (sessionId) {
      for (const entry of this.sessionRuntimes.values()) {
        if (entry.info.workspaceId === workspaceId && entry.info.sessionId === sessionId) return entry.manager
      }
    }
    return this.getPiManager(workspaceId)
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
      piManager.stop()
      this.piManagers.delete(workspaceId)
    }
    for (const [runtimeId, entry] of this.sessionRuntimes) {
      if (entry.info.workspaceId !== workspaceId) continue
      if (this.activeRuntimeId === runtimeId) this.activeRuntimeId = null
      entry.manager.stop()
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

  /**
   * Reuse an existing checkout when the task identifies it safely. Exact task
   * metadata and a GitHub PR head branch are deterministic; a branch named in
   * the task is also accepted, but ambiguous matches are ignored.
   */
  private async findRelatedWorktree(sourcePath: string, repoRoot: string, taskPrompt: string): Promise<Workspace | null> {
    const normalizedTask = taskPrompt.trim().replace(/\s+/g, ' ').toLowerCase()
    if (!normalizedTask) return null

    const savedMatch = this.workspaces.find((workspace) =>
      workspace.kind === 'worktree' &&
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
      .filter((entry) => !entry.bare && existsSync(entry.path) && entry.branch)
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
    if (taskPrompt) {
      const related = await this.findRelatedWorktree(source.path, git.repoRoot, taskPrompt)
      if (related) return related
    }
    const sourceWasDirty = git.status.trim().length > 0
    const id = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const label = options.name?.trim() || `${source.name}-tab`
    const branch = worktreeBranchName(label, id)
    const targetPath = worktreeTargetPath(getGuiDataPath('worktrees'), git.repoRoot, id)
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
