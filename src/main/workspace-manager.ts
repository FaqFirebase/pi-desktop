import { dirname } from 'path'
import { readFile, writeFile, mkdir, rename, copyFile } from 'fs/promises'
import { existsSync } from 'fs'
import { PiRpcManager } from './pi-rpc-manager'
import { FileService } from './file-service'
import type { FileChangeEvent, PiStartOptions } from '../shared/ipc-contracts'
import { getGuiDataPath } from './app-data-paths'

/**
 * Manages multiple workspaces (project directories), each with its own Pi process.
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

export class WorkspaceManager {
  private workspaces: Workspace[] = []
  private activeWorkspaceId: string | null = null
  private piManagers = new Map<string, PiRpcManager>()
  private fileServices = new Map<string, FileService>()
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

  async initialize(): Promise<void> {
    await this.loadWorkspaces()

    // Auto-create default workspace from home dir if none exist
    if (this.workspaces.length === 0) {
      const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? process.cwd()
      await this.createWorkspace('Home', homeDir)
    }

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
    return this.piManagers.get(workspaceId) ?? null
  }

  getActivePiManager(): PiRpcManager | null {
    if (!this.activeWorkspaceId) return null
    return this.piManagers.get(this.activeWorkspaceId) ?? null
  }

  getFileService(workspaceId: string): FileService | null {
    return this.fileServices.get(workspaceId) ?? null
  }

  getActiveFileService(): FileService | null {
    if (!this.activeWorkspaceId) return null
    return this.fileServices.get(this.activeWorkspaceId) ?? null
  }

  async createWorkspace(name: string, path: string): Promise<Workspace> {
    // Check for duplicate path
    const existing = this.workspaces.find((w) => w.path === path)
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
    this.activeWorkspaceId = workspaceId

    await this.saveWorkspaces()
    if (changed) this.emitActiveWorkspaceChanged()
    return workspace
  }

  async removeWorkspace(workspaceId: string): Promise<void> {
    const index = this.workspaces.findIndex((w) => w.id === workspaceId)
    if (index === -1) throw new Error(`Workspace not found: ${workspaceId}`)

    // Stop Pi process and file watcher for this workspace
    const piManager = this.piManagers.get(workspaceId)
    if (piManager) {
      piManager.stop()
      this.piManagers.delete(workspaceId)
    }
    const fileService = this.fileServices.get(workspaceId)
    if (fileService) {
      fileService.stopWatching()
      this.fileServices.delete(workspaceId)
    }

    this.workspaces.splice(index, 1)

    // If removed workspace was active, switch to first available
    let activeChanged = false
    if (this.activeWorkspaceId === workspaceId) {
      this.activeWorkspaceId = this.workspaces.length > 0 ? this.workspaces[0].id : null
      activeChanged = true
    }

    await this.saveWorkspaces()
    if (activeChanged) this.emitActiveWorkspaceChanged()
  }

  async renameWorkspace(workspaceId: string, name: string): Promise<void> {
    const workspace = this.workspaces.find((w) => w.id === workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)

    workspace.name = name
    await this.saveWorkspaces()
  }

  /**
   * Repoint a workspace at a different folder. Replaces its FileService (which
   * binds the path at construction) and re-arms watching if it's the active one.
   * Pi must be restarted separately to pick up the new cwd.
   */
  async changeWorkspacePath(workspaceId: string, newPath: string): Promise<void> {
    const workspace = this.workspaces.find((w) => w.id === workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    if (!existsSync(newPath)) throw new Error(`Folder does not exist: ${newPath}`)

    workspace.path = newPath
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

  async startPiForWorkspace(workspaceId: string, options?: PiStartOptions): Promise<void> {
    const workspace = this.workspaces.find((w) => w.id === workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)

    let piManager = this.piManagers.get(workspaceId)
    if (!piManager) {
      piManager = new PiRpcManager()
      this.piManagers.set(workspaceId, piManager)
    }
    this.wirePiManager(piManager)

    // Caller-supplied cwd (e.g. a validated fallback) takes precedence over the
    // workspace path. Default to the workspace path when no override is given.
    await piManager.start({
      cwd: workspace.path,
      ...options,
    })
  }

  stopPiForWorkspace(workspaceId: string): void {
    const piManager = this.piManagers.get(workspaceId)
    if (piManager) {
      piManager.stop()
    }
  }

  stopAll(): void {
    for (const [, manager] of this.piManagers) {
      manager.stop()
    }
    for (const [, fs] of this.fileServices) {
      fs.stopWatching()
    }
    this.watchingWorkspaceId = null
    this.piManagers.clear()
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

    this.workspaces = state.workspaces ?? []
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
    }
  }
}
