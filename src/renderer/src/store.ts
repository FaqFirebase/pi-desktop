import { create } from 'zustand'
import type {
  PiRpcEvent,
  PiStatus,
  PiProcessStatus,
  SessionState,
  SessionStats,
  SessionListItem,
  ModelInfo,
  AppSettings,
  PiMessageUpdateEvent,
  PiToolExecutionStartEvent,
  PiToolExecutionEndEvent,
  PiToolExecutionUpdateEvent,
  PiQueueUpdateEvent,
  PiCompactionStartEvent,
  PiCompactionEndEvent,
  PiAutoRetryStartEvent,
  PiAutoRetryEndEvent,
  PiExtensionUiRequest,
  Workspace,
  InstalledPackage,
  InstalledSkill,
  CatalogPackage,
  TimelineEvent,
  PermissionMode,
} from '../../shared/ipc-contracts'

// ─── Message State (renderer-local, built from events) ───────────────────────

export interface DisplayMessage {
  id: string
  role: 'user' | 'assistant' | 'toolResult' | 'system'
  content: string
  timestamp: number
  isStreaming?: boolean
  toolCalls?: Array<{
    id: string
    name: string
    arguments: string
    result?: string
    isError?: boolean
    isExecuting?: boolean
  }>
  thinking?: string
  model?: string
  provider?: string
  cost?: number
}

// ─── Store Shape ─────────────────────────────────────────────────────────────

interface AppState {
  // PI process
  piStatus: PiProcessStatus
  piPid: number | null
  piError: string | null

  // Session
  sessionState: SessionState | null
  sessionStats: SessionStats | null
  sessionList: SessionListItem[]

  // Messages
  messages: DisplayMessage[]
  streamingContent: string
  streamingThinking: string
  streamingToolCalls: Map<string, { name: string; args: string; isExecuting: boolean }>
  isStreaming: boolean

  // Queue
  pendingSteering: string[]
  pendingFollowUp: string[]

  // UI
  currentView: 'chat' | 'settings' | 'sessions' | 'timeline' | 'packages' | 'diff'
  sidebarOpen: boolean
  terminalOpen: boolean
  settings: AppSettings | null
  commands: Array<{ name: string; description: string; source: string }>

  // Extension UI
  extensionUiRequest: PiExtensionUiRequest | null

  // Workspaces
  workspaces: Workspace[]
  activeWorkspace: Workspace | null

  // Timeline
  timelineEvents: TimelineEvent[]

  // Packages
  installedPackages: InstalledPackage[]
  catalogPackages: CatalogPackage[]
  packageLoading: boolean
  packageSearchQuery: string
  packageNotification: { type: 'success' | 'error'; message: string } | null

  // Skills
  installedSkills: InstalledSkill[]

  // File preview
  selectedFile: { relativePath: string; path: string } | null

  // File search
  fileSearchOpen: boolean

  // Session tags
  sessionTags: Record<string, string[]>
  allUsedTags: string[]

  // Archived sessions (GUI-only registry — PI has no archive concept)
  archivedSessions: Record<string, number>
  showArchived: boolean
}

interface AppActions {
  // PI lifecycle
  setPiStatus: (status: PiStatus) => void
  startPi: (options?: Record<string, unknown>) => Promise<void>
  stopPi: () => Promise<void>
  restartPi: (options?: Record<string, unknown>) => Promise<void>

  // Messages
  addMessage: (message: DisplayMessage) => void
  setMessages: (messages: DisplayMessage[]) => void
  clearMessages: () => void

  // Prompts
  sendPrompt: (message: string, options?: { images?: unknown[] }) => Promise<void>
  sendSteer: (message: string) => Promise<void>
  sendFollowUp: (message: string) => Promise<void>
  abort: () => Promise<void>

  // Session
  createNewSession: () => Promise<void>
  switchSession: (path: string) => Promise<void>
  refreshSessionState: () => Promise<void>
  refreshSessionStats: () => Promise<void>
  refreshSessionList: () => Promise<void>
  setSessionName: (name: string) => Promise<void>

  // Model
  setModel: (provider: string, modelId: string) => Promise<void>
  cycleModel: () => Promise<void>
  listModels: () => Promise<void>

  // Thinking
  setThinkingLevel: (level: string) => Promise<void>
  cycleThinkingLevel: () => Promise<void>

  // UI
  setCurrentView: (view: AppState['currentView']) => void
  toggleSidebar: () => void
  toggleTerminal: () => void
  loadSettings: () => Promise<void>
  setPermissionMode: (mode: PermissionMode) => Promise<void>
  loadCommands: () => Promise<void>

  // Events
  handlePiEvent: (event: PiRpcEvent) => void

  // Extension UI
  respondExtensionUi: (id: string, response: Record<string, unknown>) => void
  dismissExtensionUi: () => void

  // Workspaces
  loadWorkspaces: () => Promise<void>
  createWorkspace: (name: string, path: string) => Promise<void>
  switchWorkspace: (workspaceId: string) => Promise<void>
  removeWorkspace: (workspaceId: string) => Promise<void>
  renameWorkspace: (workspaceId: string, name: string) => Promise<void>

  // Timeline
  addTimelineEvent: (event: TimelineEvent) => void
  clearTimeline: () => void

  // Packages
  loadInstalledPackages: () => Promise<void>
  installPackage: (spec: string) => Promise<void>
  removePackage: (spec: string) => Promise<void>
  searchCatalog: (query?: string) => Promise<void>
  setPackageSearchQuery: (query: string) => void
  clearPackageNotification: () => void

  // Skills
  loadSkills: () => Promise<void>

  // File preview
  setSelectedFile: (relativePath: string | null, path: string | null) => void

  // File search
  toggleFileSearch: () => void

  // Session tags
  loadTags: () => Promise<void>
  addSessionTag: (sessionId: string, tag: string) => Promise<void>
  removeSessionTag: (sessionId: string, tag: string) => Promise<void>
  getTagsForSession: (sessionId: string) => string[]

  // Archive / delete
  loadArchivedSessions: () => Promise<void>
  archiveSession: (sessionId: string) => Promise<void>
  unarchiveSession: (sessionId: string) => Promise<void>
  deleteSession: (session: SessionListItem) => Promise<{ ok: boolean; method: 'trash' | 'unlink'; error?: string }>
  toggleShowArchived: () => void
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

let messageCounter = 0
function generateId(): string {
  return `msg-${Date.now()}-${++messageCounter}`
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((block: unknown) => {
        if (typeof block !== 'object' || block === null) return false
        const b = block as Record<string, unknown>
        return b.type === 'text' && typeof b.text === 'string'
      })
      .map((block) => (block as { text: string }).text)
      .join('')
  }
  return ''
}

/**
 * Walk the timeline backwards, find the most recent event matching the
 * predicate that still has status 'running', and close it with the given
 * status (recording duration). Returns a new array (or the same array if
 * nothing matched).
 */
function closeMostRecentRunning(
  events: TimelineEvent[],
  match: (event: TimelineEvent) => boolean,
  status: 'success' | 'error' | 'cancelled'
): TimelineEvent[] {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.status !== 'running') continue
    if (!match(e)) continue
    const next = events.slice()
    next[i] = { ...e, status, duration: Date.now() - e.timestamp }
    return next
  }
  return events
}

// ─── Store ───────────────────────────────────────────────────────────────────

export const useAppStore = create<AppState & AppActions>((set, get) => ({
  // ─── Initial State ────────────────────────────────────────────────────

  piStatus: 'stopped',
  piPid: null,
  piError: null,

  sessionState: null,
  sessionStats: null,
  sessionList: [],

  messages: [],
  streamingContent: '',
  streamingThinking: '',
  streamingToolCalls: new Map(),
  isStreaming: false,

  pendingSteering: [],
  pendingFollowUp: [],

  currentView: 'chat',
  sidebarOpen: true,
  terminalOpen: false,
  settings: null,
  commands: [],

  extensionUiRequest: null,

  workspaces: [],
  activeWorkspace: null,

  timelineEvents: [],

  installedPackages: [],
  catalogPackages: [],
  packageLoading: false,
  packageSearchQuery: '',
  packageNotification: null,

  installedSkills: [],

  selectedFile: null,

  fileSearchOpen: false,

  sessionTags: {},
  allUsedTags: [],

  archivedSessions: {},
  showArchived: false,

  // ─── PI Lifecycle ─────────────────────────────────────────────────────

  setPiStatus: (status) =>
    set({
      piStatus: status.status,
      piPid: status.pid,
      piError: status.error,
    }),

  startPi: async (options) => {
    // Don't start if already running
    if (get().piStatus === 'running') return

    try {
      const status = await window.piDesktop.pi.start(options as Record<string, unknown> | undefined)
      set({ piStatus: status.status, piPid: status.pid, piError: status.error })

      if (status.status === 'running') {
        get().refreshSessionState()
        get().refreshSessionStats()
        get().refreshSessionList()
      }
    } catch (err) {
      set({ piStatus: 'error', piError: err instanceof Error ? err.message : String(err) })
    }
  },

  stopPi: async () => {
    try {
      const status = await window.piDesktop.pi.stop()
      set({ piStatus: status.status, piPid: status.pid, piError: status.error })
    } catch (err) {
      set({ piStatus: 'error', piError: err instanceof Error ? err.message : String(err) })
    }
  },

  restartPi: async (options) => {
    try {
      const status = await window.piDesktop.pi.restart(options as Record<string, unknown> | undefined)
      set({ piStatus: status.status, piPid: status.pid, piError: status.error })
    } catch (err) {
      set({ piStatus: 'error', piError: err instanceof Error ? err.message : String(err) })
    }
  },

  // ─── Messages ─────────────────────────────────────────────────────────

  addMessage: (message) =>
    set((state) => ({
      messages: [...state.messages, message],
    })),

  setMessages: (messages) => set({ messages }),

  clearMessages: () => set({ messages: [], streamingContent: '', streamingThinking: '', streamingToolCalls: new Map() }),

  // ─── Prompts ──────────────────────────────────────────────────────────

  sendPrompt: async (message, options) => {
    const { piStatus, isStreaming, sessionState } = get()

    if (piStatus !== 'running') return

    // Extract #tags from message
    const tagMatches = message.match(/#([a-z0-9_-]+)/gi)
    if (tagMatches && sessionState?.sessionId) {
      for (const match of tagMatches) {
        const tag = match.slice(1).toLowerCase()
        await get().addSessionTag(sessionState.sessionId, tag)
      }
    }

    // Add user message immediately
    get().addMessage({
      id: generateId(),
      role: 'user',
      content: message,
      timestamp: Date.now(),
    })

    set({ isStreaming: true, streamingContent: '', streamingThinking: '', streamingToolCalls: new Map() })

    try {
      if (isStreaming) {
        // Queue as steering during streaming
        await window.piDesktop.commands.steer(message)
      } else {
        await window.piDesktop.commands.prompt(message, options)
      }
    } catch (err) {
      get().addMessage({
        id: generateId(),
        role: 'system',
        content: `Error: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now(),
      })
      set({ isStreaming: false })
    }
  },

  sendSteer: async (message) => {
    try {
      await window.piDesktop.commands.steer(message)
    } catch (err) {
      get().addMessage({
        id: generateId(),
        role: 'system',
        content: `Steer error: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now(),
      })
    }
  },

  sendFollowUp: async (message) => {
    try {
      await window.piDesktop.commands.followUp(message)
    } catch (err) {
      get().addMessage({
        id: generateId(),
        role: 'system',
        content: `Follow-up error: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now(),
      })
    }
  },

  abort: async () => {
    try {
      await window.piDesktop.commands.abort()
      set({ isStreaming: false })
    } catch {
      // Abort may fail if nothing is running
    }
  },

  // ─── Session ──────────────────────────────────────────────────────────

  createNewSession: async () => {
    try {
      const result = await window.piDesktop.session.createNew() as { success?: boolean; error?: string } | null
      if (result && result.success === false) {
        get().addMessage({
          id: generateId(),
          role: 'system',
          content: result.error ?? 'Cannot create session — PI not running',
          timestamp: Date.now(),
        })
        return
      }
      get().clearMessages()
      get().refreshSessionState()
      get().refreshSessionStats()
      get().refreshSessionList()
    } catch (err) {
      get().addMessage({
        id: generateId(),
        role: 'system',
        content: `New session error: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now(),
      })
    }
  },

  switchSession: async (path) => {
    try {
      const result = await window.piDesktop.session.switch(path) as { success?: boolean; error?: string } | null
      if (result && result.success === false) {
        get().addMessage({
          id: generateId(),
          role: 'system',
          content: result.error ?? 'Cannot switch session — PI not running',
          timestamp: Date.now(),
        })
        return
      }
      get().clearMessages()
      get().refreshSessionState()
      get().refreshSessionStats()
      // Reload messages for the new session
      const response = await window.piDesktop.session.getMessages()
      if (response && typeof response === 'object') {
        const resp = response as { success?: boolean; data?: { messages?: unknown[] } }
        if (resp.success && resp.data?.messages) {
          const loaded = (resp.data.messages as unknown[])
            .map(parseAgentMessage)
            .filter((m): m is DisplayMessage => m !== null)
          set({ messages: loaded })
        }
      }
    } catch (err) {
      get().addMessage({
        id: generateId(),
        role: 'system',
        content: `Switch session error: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now(),
      })
    }
  },

  refreshSessionState: async () => {
    try {
      const response = await window.piDesktop.session.getState()
      if (response && typeof response === 'object') {
        const resp = response as { success?: boolean; data?: SessionState }
        if (resp.success && resp.data) {
          set({ sessionState: resp.data })
        }
      }
    } catch {
      // Silent failure
    }
  },

  refreshSessionStats: async () => {
    try {
      const response = await window.piDesktop.session.getStats()
      if (response && typeof response === 'object') {
        const resp = response as { success?: boolean; data?: SessionStats }
        if (resp.success && resp.data) {
          set({ sessionStats: resp.data })
        }
      }
    } catch {
      // Silent failure
    }
  },

  refreshSessionList: async () => {
    try {
      const list = await window.piDesktop.session.list()
      set({ sessionList: list })
    } catch {
      // Silent failure
    }
  },

  setSessionName: async (name) => {
    try {
      await window.piDesktop.session.setName(name)
      get().refreshSessionState()
    } catch {
      // Silent failure
    }
  },

  // ─── Model ────────────────────────────────────────────────────────────

  setModel: async (provider, modelId) => {
    try {
      await window.piDesktop.model.set(provider, modelId)
      get().refreshSessionState()
    } catch (err) {
      get().addMessage({
        id: generateId(),
        role: 'system',
        content: `Model error: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now(),
      })
    }
  },

  cycleModel: async () => {
    try {
      await window.piDesktop.model.cycle()
      get().refreshSessionState()
    } catch {
      // Silent failure
    }
  },

  listModels: async () => {
    try {
      await window.piDesktop.model.listAvailable()
    } catch {
      // Silent failure
    }
  },

  // ─── Thinking ─────────────────────────────────────────────────────────

  setThinkingLevel: async (level) => {
    try {
      await window.piDesktop.thinking.setLevel(level)
      get().refreshSessionState()
    } catch {
      // Silent failure
    }
  },

  cycleThinkingLevel: async () => {
    try {
      await window.piDesktop.thinking.cycleLevel()
      get().refreshSessionState()
    } catch {
      // Silent failure
    }
  },

  // ─── UI ───────────────────────────────────────────────────────────────

  setCurrentView: (view) => set({ currentView: view }),

  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),

  toggleTerminal: () => set((state) => ({ terminalOpen: !state.terminalOpen })),

  loadSettings: async () => {
    try {
      const settings = await window.piDesktop.settings.getAll()
      set({ settings })

      // Apply theme
      const html = document.documentElement
      html.classList.remove('dark', 'light', 'nord', 'gruvbox')
      if (settings.theme === 'light') {
        html.classList.add('light')
        html.style.colorScheme = 'light'
      } else if (settings.theme === 'system') {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
        html.classList.add(prefersDark ? 'dark' : 'light')
        html.style.colorScheme = prefersDark ? 'dark' : 'light'
      } else {
        // 'dark' | 'nord' | 'gruvbox' — all dark-based
        html.classList.add(settings.theme)
        html.style.colorScheme = 'dark'
      }

      // Apply font size
      document.documentElement.style.fontSize = `${settings.fontSize}px`
    } catch {
      // Silent failure
    }
  },

  setPermissionMode: async (mode) => {
    const updated = await window.piDesktop.settings.save({ permissionMode: mode })
    set({ settings: updated })
  },

  loadCommands: async () => {
    try {
      // Commands are loaded via RPC get_commands
      set({ commands: [] })
    } catch {
      // Silent failure
    }
  },

  // ─── Event Handling ───────────────────────────────────────────────────

  handlePiEvent: (event) => {
    switch (event.type) {
      case 'message_update':
        handleMessageUpdate(event as PiMessageUpdateEvent, set)
        break

      case 'message_end':
        handleTurnComplete(set)
        get().addTimelineEvent({
          id: generateId(),
          type: 'assistant_message',
          timestamp: Date.now(),
          title: 'Assistant response complete',
          status: 'success',
        })
        break

      case 'turn_end':
        handleTurnComplete(set)
        break

      case 'agent_start':
        get().addTimelineEvent({
          id: generateId(),
          type: 'system',
          timestamp: Date.now(),
          title: 'Agent started processing',
          status: 'running',
        })
        break

      case 'agent_end':
        set((state) => ({
          isStreaming: false,
          // Close out the matching 'Agent started processing' entry so its
          // spinner stops. Without this, the run-state indicator on the
          // start entry persists forever even after the agent completes.
          timelineEvents: closeMostRecentRunning(state.timelineEvents, (e) =>
            e.type === 'system' && e.title === 'Agent started processing'
          , 'success'),
        }))
        get().refreshSessionStats()
        get().addTimelineEvent({
          id: generateId(),
          type: 'system',
          timestamp: Date.now(),
          title: 'Agent finished',
          status: 'success',
        })
        break

      case 'tool_execution_start':
        handleToolStart(event as PiToolExecutionStartEvent, set)
        get().addTimelineEvent({
          id: generateId(),
          type: 'tool_start',
          timestamp: Date.now(),
          title: `Tool: ${(event as PiToolExecutionStartEvent).toolName}`,
          detail: JSON.stringify((event as PiToolExecutionStartEvent).args).slice(0, 200),
          status: 'running',
          metadata: { toolCallId: (event as PiToolExecutionStartEvent).toolCallId },
        })
        break

      case 'tool_execution_update':
        handleToolUpdate(event as PiToolExecutionUpdateEvent, set)
        break

      case 'tool_execution_end': {
        handleToolEnd(event as PiToolExecutionEndEvent, set)
        const toolEvent = event as PiToolExecutionEndEvent
        set((state) => ({
          // Close out the matching tool_start entry (paired by toolCallId)
          // so its spinner stops.
          timelineEvents: closeMostRecentRunning(state.timelineEvents, (e) =>
            e.type === 'tool_start' &&
            (e.metadata as Record<string, unknown> | undefined)?.toolCallId === toolEvent.toolCallId
          , toolEvent.isError ? 'error' : 'success'),
        }))
        get().addTimelineEvent({
          id: generateId(),
          type: 'tool_end',
          timestamp: Date.now(),
          title: `Tool: ${toolEvent.toolName}`,
          status: toolEvent.isError ? 'error' : 'success',
          metadata: { toolCallId: toolEvent.toolCallId },
        })
        break
      }

      case 'queue_update':
        handleQueueUpdate(event as PiQueueUpdateEvent, set)
        break

      case 'compaction_start':
      case 'compaction_end':
        handleCompaction(event as PiCompactionStartEvent | PiCompactionEndEvent, set)
        get().addTimelineEvent({
          id: generateId(),
          type: 'compaction',
          timestamp: Date.now(),
          title: event.type === 'compaction_start' ? 'Compaction started' : 'Compaction complete',
          status: event.type === 'compaction_start' ? 'running' : 'success',
        })
        break

      case 'auto_retry_start':
      case 'auto_retry_end':
        handleAutoRetry(event as PiAutoRetryStartEvent | PiAutoRetryEndEvent, set, get)
        get().addTimelineEvent({
          id: generateId(),
          type: 'retry',
          timestamp: Date.now(),
          title: event.type === 'auto_retry_start' ? `Retry attempt ${(event as PiAutoRetryStartEvent).attempt}` : 'Retry complete',
          status: event.type === 'auto_retry_start' ? 'running' : ((event as PiAutoRetryEndEvent).success ? 'success' : 'error'),
        })
        break

      case 'extension_ui_request':
        set({ extensionUiRequest: event as PiExtensionUiRequest })
        break

      case 'status_change': {
        const statusEvent = event as unknown as PiStatus
        set({
          piStatus: statusEvent.status,
          piPid: statusEvent.pid,
          piError: statusEvent.error,
        })
        break
      }
    }
  },

  respondExtensionUi: (id, response) => {
    const { extensionUiRequest } = get()
    if (!extensionUiRequest || extensionUiRequest.id !== id) return

    if (extensionUiRequest.method === 'confirm') {
      window.piDesktop.ui.respondConfirm(id, !!response.confirmed)
    } else if (extensionUiRequest.method === 'select' || extensionUiRequest.method === 'input' || extensionUiRequest.method === 'editor') {
      window.piDesktop.ui.respondInput(id, String(response.value ?? ''))
    }

    set({ extensionUiRequest: null })
  },

  dismissExtensionUi: () => {
    const { extensionUiRequest } = get()
    if (extensionUiRequest) {
      if (extensionUiRequest.method === 'confirm') {
        window.piDesktop.ui.respondConfirm(extensionUiRequest.id, false)
      } else {
        window.piDesktop.ui.respondInput(extensionUiRequest.id, '')
      }
      set({ extensionUiRequest: null })
    }
  },

  // ─── Workspaces ──────────────────────────────────────────────────────

  loadWorkspaces: async () => {
    try {
      const workspaces = await window.piDesktop.workspace.list()
      const active = await window.piDesktop.workspace.getActive()
      set({ workspaces, activeWorkspace: active })
    } catch {
      // Silent failure
    }
  },

  createWorkspace: async (name, path) => {
    try {
      await window.piDesktop.workspace.create(name, path)
      await get().loadWorkspaces()
    } catch (err) {
      get().addMessage({
        id: generateId(),
        role: 'system',
        content: `Create workspace error: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now(),
      })
    }
  },

  switchWorkspace: async (workspaceId) => {
    try {
      await window.piDesktop.workspace.setActive(workspaceId)
      get().clearMessages()
      // Re-sync PI status from main: each workspace has its own PiRpcManager,
      // so the new active workspace's PI may be in a different state than
      // what piStatus is currently showing. Without this, the `if running return`
      // guard in startPi() would skip starting the new workspace's PI.
      const status = await window.piDesktop.pi.getStatus()
      set({ piStatus: status.status, piPid: status.pid, piError: status.error })
      await get().loadWorkspaces()
      await get().refreshSessionState()
      await get().refreshSessionStats()
      await get().refreshSessionList()
      await get().startPi()
    } catch (err) {
      get().addMessage({
        id: generateId(),
        role: 'system',
        content: `Switch workspace error: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now(),
      })
    }
  },

  removeWorkspace: async (workspaceId) => {
    try {
      await window.piDesktop.workspace.remove(workspaceId)
      await get().loadWorkspaces()
    } catch (err) {
      get().addMessage({
        id: generateId(),
        role: 'system',
        content: `Remove workspace error: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now(),
      })
    }
  },

  renameWorkspace: async (workspaceId, name) => {
    try {
      await window.piDesktop.workspace.rename(workspaceId, name)
      await get().loadWorkspaces()
    } catch {
      // Silent failure
    }
  },

  // ─── Timeline ────────────────────────────────────────────────────────

  addTimelineEvent: (event) =>
    set((state) => ({
      timelineEvents: [...state.timelineEvents, event].slice(-500), // Keep last 500 events
    })),

  clearTimeline: () => set({ timelineEvents: [] }),

  // ─── Packages ────────────────────────────────────────────────────────

  loadInstalledPackages: async () => {
    try {
      const packages = await window.piDesktop.packages.listInstalled()
      set({ installedPackages: packages })
    } catch {
      // Silent failure
    }
  },

  installPackage: async (spec) => {
    set({ packageLoading: true, packageNotification: null })
    try {
      const result = await window.piDesktop.packages.install(spec)
      if (result.success) {
        await get().loadInstalledPackages()
        set({ packageNotification: { type: 'success', message: `Installed ${spec}. Restart PI to load it.` } })
      } else {
        set({ packageNotification: { type: 'error', message: result.output || 'Install failed' } })
      }
    } catch (err) {
      set({ packageNotification: { type: 'error', message: err instanceof Error ? err.message : String(err) } })
    } finally {
      set({ packageLoading: false })
    }
  },

  removePackage: async (spec) => {
    set({ packageLoading: true, packageNotification: null })
    try {
      const result = await window.piDesktop.packages.remove(spec)
      if (result.success) {
        await get().loadInstalledPackages()
        set({ packageNotification: { type: 'success', message: `Removed ${spec}` } })
      } else {
        set({ packageNotification: { type: 'error', message: result.output || 'Remove failed' } })
      }
    } catch (err) {
      set({ packageNotification: { type: 'error', message: err instanceof Error ? err.message : String(err) } })
    } finally {
      set({ packageLoading: false })
    }
  },

  searchCatalog: async (query) => {
    set({ packageLoading: true })
    try {
      const packages = await window.piDesktop.packages.fetchCatalog(query)
      set({ catalogPackages: packages })
    } catch {
      // Silent failure
    } finally {
      set({ packageLoading: false })
    }
  },

  setPackageSearchQuery: (query) => set({ packageSearchQuery: query }),

  clearPackageNotification: () => set({ packageNotification: null }),

  // ─── Skills ──────────────────────────────────────────────────────────

  loadSkills: async () => {
    try {
      const skills = await window.piDesktop.skills.list()
      set({ installedSkills: skills })
    } catch {
      // Silent failure
    }
  },

  setSelectedFile: (relativePath, path) => {
    set({ selectedFile: relativePath && path ? { relativePath, path } : null })
  },

  toggleFileSearch: () => {
    set((state) => ({ fileSearchOpen: !state.fileSearchOpen }))
  },

  // ─── Session Tags ────────────────────────────────────────────────────

  loadTags: async () => {
    try {
      const [allTags, usedTags] = await Promise.all([
        window.piDesktop.tags.getAll(),
        window.piDesktop.tags.getAllUsed(),
      ])
      set({ sessionTags: allTags, allUsedTags: usedTags })
    } catch {
      // Silent failure
    }
  },

  addSessionTag: async (sessionId, tag) => {
    try {
      const tags = await window.piDesktop.tags.add(sessionId, tag)
      set((state) => ({
        sessionTags: { ...state.sessionTags, [sessionId]: tags },
      }))
      // Refresh used tags
      const usedTags = await window.piDesktop.tags.getAllUsed()
      set({ allUsedTags: usedTags })
    } catch {
      // Silent failure
    }
  },

  removeSessionTag: async (sessionId, tag) => {
    try {
      const tags = await window.piDesktop.tags.remove(sessionId, tag)
      set((state) => ({
        sessionTags: { ...state.sessionTags, [sessionId]: tags },
      }))
      const usedTags = await window.piDesktop.tags.getAllUsed()
      set({ allUsedTags: usedTags })
    } catch {
      // Silent failure
    }
  },

  getTagsForSession: (sessionId) => {
    return get().sessionTags[sessionId] ?? []
  },

  // ─── Archive / Delete ─────────────────────────────────────────────────

  loadArchivedSessions: async () => {
    try {
      const archived = await window.piDesktop.session.listArchived()
      set({ archivedSessions: archived })
    } catch {
      // Silent failure — archive registry is best-effort
    }
  },

  archiveSession: async (sessionId) => {
    try {
      const archived = await window.piDesktop.session.archive(sessionId)
      set({ archivedSessions: archived })
    } catch (err) {
      get().addMessage({
        id: generateId(),
        role: 'system',
        content: `Archive error: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now(),
      })
    }
  },

  unarchiveSession: async (sessionId) => {
    try {
      const archived = await window.piDesktop.session.unarchive(sessionId)
      set({ archivedSessions: archived })
    } catch (err) {
      get().addMessage({
        id: generateId(),
        role: 'system',
        content: `Unarchive error: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now(),
      })
    }
  },

  deleteSession: async (session) => {
    try {
      const result = await window.piDesktop.session.delete(session.path)
      if (result.ok) {
        // Refresh list and prune archive entry locally
        set((state) => {
          const next = { ...state.archivedSessions }
          delete next[session.sessionId]
          return { archivedSessions: next }
        })

        await get().refreshSessionList()

        // If the deleted session was the active one, clear the chat and create a new session
        if (get().sessionState?.sessionFile === session.path) {
          get().clearMessages()
          await get().createNewSession()
        }
      }
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      get().addMessage({
        id: generateId(),
        role: 'system',
        content: `Delete error: ${message}`,
        timestamp: Date.now(),
      })
      return { ok: false, method: 'unlink' as const, error: message }
    }
  },

  toggleShowArchived: () => set((state) => ({ showArchived: !state.showArchived })),
}))

// ─── Event Handlers ──────────────────────────────────────────────────────────

// Zustand set supports both object and callback forms
type ZustandSet = (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void

function handleMessageUpdate(
  event: PiMessageUpdateEvent,
  set: ZustandSet
): void {
  const { assistantMessageEvent } = event

  switch (assistantMessageEvent.type) {
    case 'text_delta':
      set((state) => ({
        streamingContent: state.streamingContent + (assistantMessageEvent.delta ?? ''),
      }))
      break

    case 'text_end':
      // Content is finalized in message_end
      break

    case 'thinking_delta':
      set((state) => ({
        streamingThinking: state.streamingThinking + (assistantMessageEvent.delta ?? ''),
      }))
      break

    case 'thinking_end':
      break

    case 'toolcall_start': {
      const toolCall = assistantMessageEvent.toolCall as Record<string, unknown> | undefined
      if (toolCall) {
        const callId = String(toolCall.id ?? '')
        set((state) => {
          const newMap = new Map(state.streamingToolCalls)
          newMap.set(callId, {
            name: String(toolCall.name ?? 'unknown'),
            args: '',
            isExecuting: true,
          })
          return { streamingToolCalls: newMap }
        })
      }
      break
    }

    case 'toolcall_delta': {
      const toolCall = assistantMessageEvent.toolCall as Record<string, unknown> | undefined
      if (toolCall?.id) {
        set((state) => {
          const newMap = new Map(state.streamingToolCalls)
          const existing = newMap.get(String(toolCall.id))
          if (existing) {
            newMap.set(String(toolCall.id), {
              ...existing,
              args: existing.args + (assistantMessageEvent.delta ?? ''),
            })
          }
          return { streamingToolCalls: newMap }
        })
      }
      break
    }

    case 'toolcall_end': {
      const toolCall = assistantMessageEvent.toolCall as Record<string, unknown> | undefined
      if (toolCall?.id) {
        set((state) => {
          const newMap = new Map(state.streamingToolCalls)
          const existing = newMap.get(String(toolCall.id))
          if (existing) {
            newMap.set(String(toolCall.id), {
              ...existing,
              isExecuting: false,
              args: JSON.stringify(toolCall.arguments ?? existing.args),
            })
          }
          return { streamingToolCalls: newMap }
        })
      }
      break
    }
  }
}

function handleTurnComplete(
  set: ZustandSet
): void {
  set((state) => {
    const newMessages = [...state.messages]

    // Commit streaming content as assistant message
    if (state.streamingContent || state.streamingThinking || state.streamingToolCalls.size > 0) {
      const toolCalls = Array.from(state.streamingToolCalls.entries()).map(([id, tc]) => ({
        id,
        name: tc.name,
        arguments: tc.args,
        isExecuting: false,
      }))

      newMessages.push({
        id: generateId(),
        role: 'assistant',
        content: state.streamingContent,
        timestamp: Date.now(),
        thinking: state.streamingThinking || undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      })
    }

    return {
      messages: newMessages,
      streamingContent: '',
      streamingThinking: '',
      streamingToolCalls: new Map(),
    }
  })
}

function handleToolStart(
  event: PiToolExecutionStartEvent,
  set: ZustandSet
): void {
  set((state) => {
    const newMap = new Map(state.streamingToolCalls)
    newMap.set(event.toolCallId, {
      name: event.toolName,
      args: JSON.stringify(event.args),
      isExecuting: true,
    })
    return { streamingToolCalls: newMap }
  })
}

function handleToolUpdate(
  event: PiToolExecutionUpdateEvent,
  set: ZustandSet
): void {
  const text = event.partialResult.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('')

  set((state) => {
    const newMap = new Map(state.streamingToolCalls)
    const existing = newMap.get(event.toolCallId)
    if (existing) {
      newMap.set(event.toolCallId, {
        ...existing,
        args: text || existing.args,
      })
    }
    return { streamingToolCalls: newMap }
  })
}

function handleToolEnd(
  event: PiToolExecutionEndEvent,
  set: ZustandSet
): void {
  const resultText = event.result.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('')

  set((state) => {
    const newMap = new Map(state.streamingToolCalls)
    const existing = newMap.get(event.toolCallId)
    if (existing) {
      newMap.set(event.toolCallId, {
        ...existing,
        isExecuting: false,
        args: resultText || existing.args,
      })
    }
    return { streamingToolCalls: newMap }
  })
}

function handleQueueUpdate(
  event: PiQueueUpdateEvent,
  set: ZustandSet
): void {
  set({
    pendingSteering: event.steering,
    pendingFollowUp: event.followUp,
  })
}

function handleCompaction(
  event: PiCompactionStartEvent | PiCompactionEndEvent,
  set: ZustandSet
): void {
  if (event.type === 'compaction_start') {
    set((state) => ({
      messages: [
        ...state.messages,
        {
          id: generateId(),
          role: 'system',
          content: `Compacting context (${(event as PiCompactionStartEvent).reason})...`,
          timestamp: Date.now(),
        },
      ],
    }))
  } else {
    const endEvent = event as PiCompactionEndEvent
    if (endEvent.aborted) {
      set((state) => ({
        messages: [
          ...state.messages,
          {
            id: generateId(),
            role: 'system',
            content: 'Compaction aborted.',
            timestamp: Date.now(),
          },
        ],
      }))
    } else if (endEvent.result) {
      set((state) => ({
        messages: [
          ...state.messages,
          {
            id: generateId(),
            role: 'system',
            content: 'Context compacted.',
            timestamp: Date.now(),
          },
        ],
      }))
    }
  }
}

function handleAutoRetry(
  event: PiAutoRetryStartEvent | PiAutoRetryEndEvent,
  set: ZustandSet,
  get: () => AppState & AppActions
): void {
  if (event.type === 'auto_retry_start') {
    set((state) => ({
      messages: [
        ...state.messages,
        {
          id: generateId(),
          role: 'system',
          content: `Retrying (attempt ${event.attempt}/${event.maxAttempts}): ${event.errorMessage}`,
          timestamp: Date.now(),
        },
      ],
    }))
  } else {
    const endEvent = event as PiAutoRetryEndEvent
    if (!endEvent.success) {
      set({ isStreaming: false })
      get().refreshSessionStats()
    }
  }
}

// ─── Message Parsing ─────────────────────────────────────────────────────────

function parseAgentMessage(msg: unknown): DisplayMessage | null {
  if (!msg || typeof msg !== 'object') return null

  const m = msg as Record<string, unknown>
  const role = m.role as string

  if (role === 'user') {
    return {
      id: String(m.id ?? generateId()),
      role: 'user',
      content: extractTextContent(m.content),
      timestamp: Number(m.timestamp) || Date.now(),
    }
  }

  if (role === 'assistant') {
    const content = Array.isArray(m.content) ? m.content : []
    const textParts = content
      .filter((c: unknown) => typeof c === 'object' && c !== null && (c as Record<string, unknown>).type === 'text')
      .map((c: unknown) => ((c as Record<string, unknown>).text as string) ?? '')

    const thinkingParts = content
      .filter((c: unknown) => typeof c === 'object' && c !== null && (c as Record<string, unknown>).type === 'thinking')
      .map((c: unknown) => ((c as Record<string, unknown>).thinking as string) ?? '')

    const toolCalls = content
      .filter((c: unknown) => typeof c === 'object' && c !== null && (c as Record<string, unknown>).type === 'toolCall')
      .map((c: unknown) => {
        const tc = c as Record<string, unknown>
        return {
          id: String(tc.id ?? ''),
          name: String(tc.name ?? ''),
          arguments: JSON.stringify(tc.arguments ?? {}),
        }
      })

    return {
      id: String(m.id ?? generateId()),
      role: 'assistant',
      content: textParts.join(''),
      timestamp: Number(m.timestamp) || Date.now(),
      thinking: thinkingParts.length > 0 ? thinkingParts.join('') : undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      model: typeof m.model === 'string' ? m.model : undefined,
      provider: typeof m.provider === 'string' ? m.provider : undefined,
    }
  }

  if (role === 'toolResult') {
    const content = Array.isArray(m.content) ? m.content : []
    const text = content
      .filter((c: unknown) => typeof c === 'object' && c !== null && (c as Record<string, unknown>).type === 'text')
      .map((c: unknown) => ((c as Record<string, unknown>).text as string) ?? '')
      .join('')

    return {
      id: String(m.id ?? generateId()),
      role: 'toolResult',
      content: text,
      timestamp: Number(m.timestamp) || Date.now(),
    }
  }

  return null
}
