import { join } from 'path'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { PiRpcManager } from './pi-rpc-manager'
import { FileService } from './file-service'
import type { PiStartOptions } from '../shared/ipc-contracts'

/**
 * Manages multiple workspaces (project directories), each with its own PI process.
 *
 * Persistence: workspace list stored in ~/.pi-desktop-gui/workspaces.json
 */

const CONFIG_DIR_NAME = '.pi-desktop-gui'
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

export class WorkspaceManager {
  private workspaces: Workspace[] = []
  private activeWorkspaceId: string | null = null
  private piManagers = new Map<string, PiRpcManager>()
  private fileServices = new Map<string, FileService>()
  private configPath: string
  private nextColorIndex = 0
  private piManagerListeners: PiManagerListener[] = []
  private wiredPiManagers = new WeakSet<PiRpcManager>()

  constructor() {
    const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? ''
    this.configPath = join(homeDir, CONFIG_DIR_NAME, WORKSPACES_FILE)
  }

  onPiManager(listener: PiManagerListener): void {
    this.piManagerListeners.push(listener)
    for (const manager of this.piManagers.values()) {
      this.wirePiManager(manager)
    }
  }

  private wirePiManager(manager: PiRpcManager): void {
    if (this.wiredPiManagers.has(manager)) return
    this.wiredPiManagers.add(manager)
    for (const listener of this.piManagerListeners) {
      listener(manager)
    }
  }

  async initialize(): Promise<void> {
    await this.loadWorkspaces()

    // Auto-create default workspace from home dir if none exist
    if (this.workspaces.length === 0) {
      const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? process.cwd()
      await this.createWorkspace('Home', homeDir)
    }
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

    // Create PI manager and file service for this workspace
    const piManager = new PiRpcManager()
    this.piManagers.set(workspace.id, piManager)
    this.wirePiManager(piManager)
    const fileService = new FileService(path)
    this.fileServices.set(workspace.id, fileService)

    // Auto-set as active if it's the first workspace
    if (!this.activeWorkspaceId) {
      this.activeWorkspaceId = workspace.id
    }

    await this.saveWorkspaces()
    return workspace
  }

  async setActiveWorkspace(workspaceId: string): Promise<Workspace> {
    const workspace = this.workspaces.find((w) => w.id === workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)

    workspace.lastActiveAt = Date.now()
    this.activeWorkspaceId = workspaceId

    await this.saveWorkspaces()
    return workspace
  }

  async removeWorkspace(workspaceId: string): Promise<void> {
    const index = this.workspaces.findIndex((w) => w.id === workspaceId)
    if (index === -1) throw new Error(`Workspace not found: ${workspaceId}`)

    // Stop PI process and file watcher for this workspace
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
    if (this.activeWorkspaceId === workspaceId) {
      this.activeWorkspaceId = this.workspaces.length > 0 ? this.workspaces[0].id : null
    }

    await this.saveWorkspaces()
  }

  async renameWorkspace(workspaceId: string, name: string): Promise<void> {
    const workspace = this.workspaces.find((w) => w.id === workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)

    workspace.name = name
    await this.saveWorkspaces()
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
    this.piManagers.clear()
    this.fileServices.clear()
  }

  private async loadWorkspaces(): Promise<void> {
    try {
      if (existsSync(this.configPath)) {
        const data = await readFile(this.configPath, 'utf-8')
        const state: WorkspaceState = JSON.parse(data)
        this.workspaces = state.workspaces ?? []
        this.activeWorkspaceId = state.activeWorkspaceId ?? null

        // Create file services and PI managers for loaded workspaces
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
    } catch {
      this.workspaces = []
      this.activeWorkspaceId = null
    }
  }

  private async saveWorkspaces(): Promise<void> {
    try {
      const dir = join(this.configPath, '..')
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true })
      }

      const state: WorkspaceState = {
        workspaces: this.workspaces,
        activeWorkspaceId: this.activeWorkspaceId,
      }

      await writeFile(this.configPath, JSON.stringify(state, null, 2), 'utf-8')
    } catch (err) {
      console.error('Failed to save workspaces:', err)
    }
  }
}
