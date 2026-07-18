import { contextBridge, ipcRenderer } from 'electron'
import type {
  PiRpcEvent,
  PiStartOptions,
  PiStatus,
  SessionListItem,
  SessionDeleteResult,
  ArchivedSessionsMap,
  AppSettings,
  Workspace,
  InstalledPackage,
  InstalledSkill,
  CatalogPackage,
  FileTreeNode,
  FileSearchResult,
  FileChangeEvent,
  GitFileStatus,
  TerminalExitEvent,
  TerminalStartOptions,
  TerminalStartResult,
  Note,
  NoteInput,
  NoteUpdate,
  UpdateCheckResult,
  SessionLineageRecord,
  ModelsConfig,
  ModelsReadResult,
  CouncilDetectResult,
  CouncilRunRequest,
  CouncilRunResult,
  CouncilArbiterRequest,
  CouncilArbiterResult,
  CouncilProgressEvent,
  AttachmentReadResult,
  OpenDialogOptions,
  PromptImage,
  ActivityStatsResult,
  ThemesListResult,
  ThemeImportResult,
  ThemeExportResult,
  ThemeGalleryResult,
} from '../shared/ipc-contracts'
import type { ThemeFile } from '../shared/theme/theme-file'
import { IPC_CHANNELS } from '../shared/ipc-contracts'

// ─── Type Definitions for the Exposed API ────────────────────────────────────

interface PiDesktopAPI {
  // Pi process lifecycle
  pi: {
    start(options?: PiStartOptions): Promise<PiStatus>
    stop(): Promise<PiStatus>
    restart(options?: PiStartOptions): Promise<PiStatus>
    getStatus(): Promise<PiStatus>
  }

  // Pi commands
  commands: {
    prompt(message: string, options?: { images?: PromptImage[]; streamingBehavior?: string }): Promise<unknown>
    steer(message: string, images?: PromptImage[]): Promise<unknown>
    followUp(message: string): Promise<unknown>
    abort(): Promise<unknown>
    bash(command: string): Promise<unknown>
    abortBash(): Promise<unknown>
  }

  // Session management
  session: {
    createNew(): Promise<unknown>
    switch(sessionPath: string): Promise<unknown>
    fork(entryId?: string): Promise<unknown>
    clone(): Promise<unknown>
    list(cwd?: string): Promise<SessionListItem[]>
    listAll(cwd?: string): Promise<SessionListItem[]>
    getState(): Promise<unknown>
    getMessages(): Promise<unknown>
    getStats(): Promise<unknown>
    setName(name: string): Promise<unknown>
    exportHtml(outputPath?: string): Promise<unknown>
    getForkMessages(): Promise<unknown>
    delete(sessionPath: string): Promise<SessionDeleteResult>
    archive(sessionId: string): Promise<ArchivedSessionsMap>
    unarchive(sessionId: string): Promise<ArchivedSessionsMap>
    listArchived(): Promise<ArchivedSessionsMap>
    getLineage(): Promise<SessionLineageRecord[]>
    compact(customInstructions?: string): Promise<unknown>
  }

  // Model management
  model: {
    set(provider: string, modelId: string): Promise<unknown>
    cycle(): Promise<unknown>
    listAvailable(): Promise<unknown>
  }

  // Thinking
  thinking: {
    setLevel(level: string): Promise<unknown>
    cycleLevel(): Promise<unknown>
  }

  // Settings
  settings: {
    getAll(): Promise<AppSettings>
    save(settings: Partial<AppSettings>): Promise<AppSettings>
  }

  // Themes (user-created theme storage)
  themes: {
    list(): Promise<ThemesListResult>
    save(file: ThemeFile, existingId?: string): Promise<{ id: string }>
    delete(id: string): Promise<void>
    installFromUrl(url: string): Promise<ThemeImportResult>
    export(file: ThemeFile): Promise<ThemeExportResult>
    import(): Promise<ThemeImportResult>
    gallery(): Promise<ThemeGalleryResult>
  }

  // Workspace management
  workspace: {
    list(): Promise<Workspace[]>
    create(name: string, path: string): Promise<Workspace>
    remove(workspaceId: string): Promise<void>
    rename(workspaceId: string, name: string): Promise<void>
    changePath(workspaceId: string, newPath: string): Promise<void>
    pathExists(): Promise<boolean>
    setActive(workspaceId: string): Promise<Workspace>
    getActive(): Promise<Workspace | null>
    startPi(workspaceId: string, options?: PiStartOptions): Promise<PiStatus>
    stopPi(workspaceId: string): Promise<PiStatus>
  }

  // Package management
  packages: {
    listInstalled(): Promise<InstalledPackage[]>
    install(spec: string): Promise<{ success: boolean; output: string }>
    remove(spec: string): Promise<{ success: boolean; output: string }>
    update(spec?: string): Promise<{ success: boolean; output: string }>
    fetchCatalog(query?: string): Promise<CatalogPackage[]>
  }

  // Models config (read/write ~/.pi/agent/models.json)
  models: {
    read(): Promise<ModelsReadResult>
    write(config: ModelsConfig): Promise<{ success: boolean; error?: string }>
  }

  council: {
    detect(): Promise<CouncilDetectResult>
    runConsultants(payload: CouncilRunRequest): Promise<CouncilRunResult>
    arbiter(payload: CouncilArbiterRequest): Promise<CouncilArbiterResult>
    onProgress(callback: (event: CouncilProgressEvent) => void): () => void
  }

  // Skills, Commands, MCP, Tags
  skills: {
    list(): Promise<InstalledSkill[]>
  }
  piCommands: {
    list(): Promise<unknown[]>
  }
  mcpServers: {
    list(): Promise<unknown[]>
  }
  tags: {
    get(sessionId: string): Promise<string[]>
    set(sessionId: string, tags: string[]): Promise<string[]>
    add(sessionId: string, tag: string): Promise<string[]>
    remove(sessionId: string, tag: string): Promise<string[]>
    getAll(): Promise<Record<string, string[]>>
    getAllUsed(): Promise<string[]>
    autoGetAll(): Promise<Record<string, string>>
    autoEnsure(sessions: Array<{ sessionId: string; path: string }>): Promise<Record<string, string>>
    autoRemove(sessionId: string): Promise<void>
  }

  // Notes (reusable prompts / commands)
  notes: {
    list(): Promise<Note[]>
    create(input: NoteInput): Promise<Note>
    update(id: string, patch: NoteUpdate): Promise<Note>
    remove(id: string): Promise<void>
  }

  // File operations
  files: {
    getTree(maxDepth?: number): Promise<FileTreeNode>
    search(query: string): Promise<FileSearchResult[]>
    searchContent(query: string): Promise<FileSearchResult[]>
    read(path: string): Promise<string>
    readAttachment(path: string): Promise<AttachmentReadResult>
    write(path: string, content: string): Promise<{ ok: boolean }>
    getDiff(filePath?: string): Promise<string>
    getStagedDiff(filePath?: string): Promise<string>
    getGitStatus(): Promise<Record<string, GitFileStatus>>
    getGitBranch(): Promise<string | null>
  }

  // System
  system: {
    openDialog(options?: OpenDialogOptions): Promise<string | null>
    getPath(name: string): Promise<string>
    openExternal(url: string): Promise<void>
    getVersion(): Promise<string>
  }

  // Activity stats
  activity: {
    getStats(): Promise<ActivityStatsResult>
  }

  // Update check (GitHub releases)
  updates: {
    check(): Promise<UpdateCheckResult>
  }

  terminal: {
    start(options?: TerminalStartOptions): Promise<TerminalStartResult>
    input(data: string): Promise<void>
    resize(cols: number, rows: number): Promise<void>
    stop(): Promise<void>
    onData(callback: (data: string) => void): () => void
    onExit(callback: (event: TerminalExitEvent) => void): () => void
  }

  // Extension UI responses
  ui: {
    respondSelect(id: string, value: string): void
    respondConfirm(id: string, confirmed: boolean): void
    respondInput(id: string, value: string): void
    respondEditor(id: string, value: string): void
  }

  // Event subscription
  onEvent(callback: (event: PiRpcEvent) => void): () => void
  onFileChange(callback: (event: FileChangeEvent) => void): () => void
  onMenuAction(callback: (action: string) => void): () => void
}

// ─── Implementation ──────────────────────────────────────────────────────────

const api: PiDesktopAPI = {
  pi: {
    start: (options?: PiStartOptions) => ipcRenderer.invoke(IPC_CHANNELS.PI_START, options),
    stop: () => ipcRenderer.invoke(IPC_CHANNELS.PI_STOP),
    restart: (options?: PiStartOptions) => ipcRenderer.invoke(IPC_CHANNELS.PI_RESTART, options),
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.PI_STATUS),
  },

  commands: {
    prompt: (message, options) => ipcRenderer.invoke(IPC_CHANNELS.PI_PROMPT, message, options),
    steer: (message, images) => ipcRenderer.invoke(IPC_CHANNELS.PI_STEER, message, images),
    followUp: (message) => ipcRenderer.invoke(IPC_CHANNELS.PI_FOLLOW_UP, message),
    abort: () => ipcRenderer.invoke(IPC_CHANNELS.PI_ABORT),
    bash: (command) => ipcRenderer.invoke(IPC_CHANNELS.PI_BASH, command),
    abortBash: () => ipcRenderer.invoke(IPC_CHANNELS.PI_ABORT_BASH),
  },

  session: {
    createNew: () => ipcRenderer.invoke(IPC_CHANNELS.SESSION_NEW),
    switch: (sessionPath) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_SWITCH, sessionPath),
    fork: (entryId) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_FORK, entryId),
    clone: () => ipcRenderer.invoke(IPC_CHANNELS.SESSION_CLONE),
    list: (cwd) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_LIST, cwd),
    listAll: (cwd) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_LIST_ALL, cwd),
    getState: () => ipcRenderer.invoke(IPC_CHANNELS.SESSION_GET_STATE),
    getMessages: () => ipcRenderer.invoke(IPC_CHANNELS.SESSION_GET_MESSAGES),
    getStats: () => ipcRenderer.invoke(IPC_CHANNELS.SESSION_GET_STATS),
    setName: (name) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_SET_NAME, name),
    exportHtml: (outputPath) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_EXPORT_HTML, outputPath),
    getForkMessages: () => ipcRenderer.invoke(IPC_CHANNELS.SESSION_GET_FORK_MESSAGES),
    getLineage: () => ipcRenderer.invoke(IPC_CHANNELS.SESSION_GET_LINEAGE),
    compact: (customInstructions) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_COMPACT, customInstructions),
    delete: (sessionPath) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_DELETE, sessionPath),
    archive: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_ARCHIVE, sessionId),
    unarchive: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_UNARCHIVE, sessionId),
    listArchived: () => ipcRenderer.invoke(IPC_CHANNELS.SESSION_LIST_ARCHIVED),
  },

  model: {
    set: (provider, modelId) => ipcRenderer.invoke(IPC_CHANNELS.MODEL_SET, provider, modelId),
    cycle: () => ipcRenderer.invoke(IPC_CHANNELS.MODEL_CYCLE),
    listAvailable: () => ipcRenderer.invoke(IPC_CHANNELS.MODEL_LIST_AVAILABLE),
  },

  thinking: {
    setLevel: (level) => ipcRenderer.invoke(IPC_CHANNELS.THINKING_SET_LEVEL, level),
    cycleLevel: () => ipcRenderer.invoke(IPC_CHANNELS.THINKING_CYCLE_LEVEL),
  },

  settings: {
    getAll: () => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET_ALL),
    save: (settings) => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SAVE, settings),
  },

  themes: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.THEMES_LIST),
    save: (file, existingId) => ipcRenderer.invoke(IPC_CHANNELS.THEMES_SAVE, file, existingId),
    delete: (id) => ipcRenderer.invoke(IPC_CHANNELS.THEMES_DELETE, id),
    installFromUrl: (url) => ipcRenderer.invoke(IPC_CHANNELS.THEMES_INSTALL_URL, url),
    export: (file) => ipcRenderer.invoke(IPC_CHANNELS.THEMES_EXPORT, file),
    import: () => ipcRenderer.invoke(IPC_CHANNELS.THEMES_IMPORT),
    gallery: () => ipcRenderer.invoke(IPC_CHANNELS.THEMES_GALLERY_LIST),
  },

  workspace: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_LIST),
    create: (name, path) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_CREATE, name, path),
    remove: (workspaceId) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_REMOVE, workspaceId),
    rename: (workspaceId, name) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_RENAME, workspaceId, name),
    changePath: (workspaceId, newPath) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_CHANGE_PATH, workspaceId, newPath),
    pathExists: () => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_PATH_EXISTS),
    setActive: (workspaceId) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_SET_ACTIVE, workspaceId),
    getActive: () => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_GET_ACTIVE),
    startPi: (workspaceId, options) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_START_PI, workspaceId, options),
    stopPi: (workspaceId) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_STOP_PI, workspaceId),
  },

  packages: {
    listInstalled: () => ipcRenderer.invoke(IPC_CHANNELS.PACKAGE_LIST_INSTALLED),
    install: (spec) => ipcRenderer.invoke(IPC_CHANNELS.PACKAGE_INSTALL, spec),
    remove: (spec) => ipcRenderer.invoke(IPC_CHANNELS.PACKAGE_REMOVE, spec),
    update: (spec) => ipcRenderer.invoke(IPC_CHANNELS.PACKAGE_UPDATE, spec),
    fetchCatalog: (query) => ipcRenderer.invoke(IPC_CHANNELS.PACKAGE_CATALOG_FETCH, query),
  },

  models: {
    read: () => ipcRenderer.invoke(IPC_CHANNELS.MODELS_READ),
    write: (config) => ipcRenderer.invoke(IPC_CHANNELS.MODELS_WRITE, config),
  },

  council: {
    detect: () => ipcRenderer.invoke(IPC_CHANNELS.COUNCIL_DETECT),
    runConsultants: (payload) => ipcRenderer.invoke(IPC_CHANNELS.COUNCIL_RUN_CONSULTANTS, payload),
    arbiter: (payload) => ipcRenderer.invoke(IPC_CHANNELS.COUNCIL_ARBITER, payload),
    onProgress: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, data: CouncilProgressEvent) => callback(data)
      ipcRenderer.on(IPC_CHANNELS.EVENT_COUNCIL_PROGRESS, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.EVENT_COUNCIL_PROGRESS, handler)
    },
  },

  skills: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.SKILLS_LIST),
  },
  piCommands: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.COMMANDS_LIST),
  },
  mcpServers: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.MCP_SERVERS_LIST),
  },
  tags: {
    get: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.TAG_GET, sessionId),
    set: (sessionId, tags) => ipcRenderer.invoke(IPC_CHANNELS.TAG_SET, sessionId, tags),
    add: (sessionId, tag) => ipcRenderer.invoke(IPC_CHANNELS.TAG_ADD, sessionId, tag),
    remove: (sessionId, tag) => ipcRenderer.invoke(IPC_CHANNELS.TAG_REMOVE, sessionId, tag),
    getAll: () => ipcRenderer.invoke(IPC_CHANNELS.TAG_GET_ALL),
    getAllUsed: () => ipcRenderer.invoke(IPC_CHANNELS.TAG_GET_ALL_USED),
    autoGetAll: () => ipcRenderer.invoke(IPC_CHANNELS.TAG_AUTO_GET_ALL),
    autoEnsure: (sessions) => ipcRenderer.invoke(IPC_CHANNELS.TAG_AUTO_ENSURE, sessions),
    autoRemove: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.TAG_AUTO_REMOVE, sessionId),
  },

  notes: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.NOTES_LIST),
    create: (input) => ipcRenderer.invoke(IPC_CHANNELS.NOTES_CREATE, input),
    update: (id, patch) => ipcRenderer.invoke(IPC_CHANNELS.NOTES_UPDATE, id, patch),
    remove: (id) => ipcRenderer.invoke(IPC_CHANNELS.NOTES_REMOVE, id),
  },

  files: {
    getTree: (maxDepth) => ipcRenderer.invoke(IPC_CHANNELS.FILE_TREE, maxDepth),
    search: (query) => ipcRenderer.invoke(IPC_CHANNELS.FILE_SEARCH, query),
    searchContent: (query) => ipcRenderer.invoke(IPC_CHANNELS.FILE_SEARCH_CONTENT, query),
    read: (path) => ipcRenderer.invoke(IPC_CHANNELS.FILE_READ, path),
    readAttachment: (path) => ipcRenderer.invoke(IPC_CHANNELS.FILE_READ_ATTACHMENT, path),
    write: (path, content) => ipcRenderer.invoke(IPC_CHANNELS.FILE_WRITE, path, content),
    getDiff: (filePath) => ipcRenderer.invoke(IPC_CHANNELS.FILE_DIFF, filePath),
    getStagedDiff: (filePath) => ipcRenderer.invoke(IPC_CHANNELS.FILE_STAGED_DIFF, filePath),
    getGitStatus: () => ipcRenderer.invoke(IPC_CHANNELS.GIT_STATUS),
    getGitBranch: () => ipcRenderer.invoke(IPC_CHANNELS.GIT_BRANCH),
  },

  system: {
    openDialog: (options) => ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_OPEN_DIALOG, options),
    getPath: (name) => ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_GET_PATH, name),
    openExternal: (url) => ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_OPEN_EXTERNAL, url),
    getVersion: () => ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_GET_VERSION),
  },

  activity: {
    getStats: () => ipcRenderer.invoke(IPC_CHANNELS.ACTIVITY_GET_STATS),
  },

  updates: {
    check: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_CHECK),
  },

  terminal: {
    start: (options) => ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_START, options),
    input: (data) => ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_INPUT, data),
    resize: (cols, rows) => ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_RESIZE, { cols, rows }),
    stop: () => ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_STOP),
    onData: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, data: string) => callback(data)
      ipcRenderer.on(IPC_CHANNELS.EVENT_TERMINAL_DATA, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.EVENT_TERMINAL_DATA, handler)
    },
    onExit: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, data: TerminalExitEvent) => callback(data)
      ipcRenderer.on(IPC_CHANNELS.EVENT_TERMINAL_EXIT, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.EVENT_TERMINAL_EXIT, handler)
    },
  },

  ui: {
    respondSelect: (id, value) => ipcRenderer.invoke(IPC_CHANNELS.UI_SELECT_RESPONSE, id, value),
    respondConfirm: (id, confirmed) => ipcRenderer.invoke(IPC_CHANNELS.UI_CONFIRM_RESPONSE, id, confirmed),
    respondInput: (id, value) => ipcRenderer.invoke(IPC_CHANNELS.UI_INPUT_RESPONSE, id, value),
    respondEditor: (id, value) => ipcRenderer.invoke(IPC_CHANNELS.UI_EDITOR_RESPONSE, id, value),
  },

  onEvent: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: PiRpcEvent) => callback(data)
    ipcRenderer.on(IPC_CHANNELS.EVENT_PI, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.EVENT_PI, handler)
    }
  },

  onFileChange: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: FileChangeEvent) => callback(data)
    ipcRenderer.on(IPC_CHANNELS.EVENT_FILE_CHANGE, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.EVENT_FILE_CHANGE, handler)
    }
  },

  onMenuAction: (callback) => {
    const handlers: Array<() => void> = []
    const actions = ['menu:new-session', 'menu:new-workspace', 'menu:open-project']

    for (const action of actions) {
      const handler = () => callback(action)
      ipcRenderer.on(action, handler)
      handlers.push(() => ipcRenderer.removeListener(action, handler))
    }

    return () => {
      for (const cleanup of handlers) cleanup()
    }
  },
}

// ─── Expose to Renderer ──────────────────────────────────────────────────────

contextBridge.exposeInMainWorld('piDesktop', api)

// Re-export the type for renderer usage
export type { PiDesktopAPI }
