import { create } from 'zustand'
import { applyTheme } from './utils/theme'
import { buildPlanningPrompt } from './utils/planning-prompt'
import { parseAgentMessage, type DisplayAttachment, type DisplayMessage } from './message-parsing'
import type { PiCommand } from '../../shared/pi-command'
import { normalizeForkMessages, type ForkPoint } from '../../shared/fork-point'
import { buildLineageTree, type LineageNode } from '../../shared/session-lineage'
import { validateModelsConfig, mergeModelsConfig, type ModelsConfig } from '../../shared/models-config'
import {
  resolveActiveMembers,
  hasQuorum,
  buildConsensusPrompt,
  buildRevisionPrompt,
  type CouncilAgentId,
  type ConsultantResult,
} from '../../shared/council-config'
import type {
  PiRpcEvent,
  PiStatus,
  PiProcessStatus,
  SessionState,
  SessionStats,
  SessionListItem,
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
  Note,
  NoteInput,
  NoteUpdate,
  UpdateCheckResult,
  PromptImage,
} from '../../shared/ipc-contracts'

export type { DisplayAttachment, DisplayMessage } from './message-parsing'

// ─── Council Run State ───────────────────────────────────────────────────────

export type CouncilPhase = 'detecting' | 'consulting' | 'merging' | 'awaiting-approval' | 'refused'

export interface CouncilRunState {
  phase: CouncilPhase
  request: string
  results: ConsultantResult[]
  // Active consultants for this run (used to render live cards while consulting).
  members?: CouncilAgentId[]
  // Live output streamed per consultant during the consulting phase.
  partials?: Record<string, string>
  // Epoch ms when the consulting phase started (drives the elapsed indicator).
  startedAt?: number
  reason?: string
}

// ─── Confirmation Dialog ─────────────────────────────────────────────────────

export interface ConfirmOptions {
  title?: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  // Style the confirm button as destructive (red).
  danger?: boolean
}

export interface ConfirmRequest extends ConfirmOptions {
  resolve: (confirmed: boolean) => void
}

// ─── Store Shape ─────────────────────────────────────────────────────────────

interface AppState {
  // Pi process
  piStatus: PiProcessStatus
  piPid: number | null
  piError: string | null

  // Session
  sessionState: SessionState | null
  sessionStats: SessionStats | null
  sessionList: SessionListItem[]
  forkMessages: ForkPoint[]

  // Messages
  messages: DisplayMessage[]
  streamingContent: string
  streamingThinking: string
  streamingToolCalls: Map<
    string,
    { name: string; args: string; result?: string; isExecuting: boolean; startedAt?: number; durationMs?: number }
  >
  isStreaming: boolean

  // Queue
  pendingSteering: string[]
  pendingFollowUp: string[]

  // UI
  currentView: 'home' | 'chat' | 'settings' | 'sessions' | 'timeline' | 'packages' | 'diff' | 'notes' | 'skills'
  // Chat side panel: which secondary view (file tree or diff) is open in
  // the chat workspace. Lifted into the store so it survives navigating
  // away from chat (e.g. into Settings) and back.
  chatSidePanel: 'files' | 'diff' | null
  sidebarOpen: boolean
  terminalOpen: boolean
  settings: AppSettings | null
  // Staged (unsaved) font-size values from the Settings sliders. When non-null
  // they take priority over the persisted setting and survive view switches, so
  // the sliders reflect the staged value on reopen and terminal/editor pick it
  // up on remount — all without touching (or persisting) `settings`.
  uiFontSizePreview: number | null
  terminalFontSizePreview: number | null
  codeEditorFontSizePreview: number | null
  commands: PiCommand[]

  // Extension UI
  extensionUiRequest: PiExtensionUiRequest | null

  // App-level confirmation dialog (themed replacement for window.confirm)
  confirmRequest: ConfirmRequest | null

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

  // Custom models config (~/.pi/agent/models.json)
  customModels: ModelsConfig | null
  customModelsError: string | null

  // Council run UI state (null when no council run is active)
  councilRun: CouncilRunState | null

  // File preview
  selectedFile: { relativePath: string; path: string } | null

  // File search
  fileSearchOpen: boolean

  // Session tags
  sessionTags: Record<string, string[]>
  allUsedTags: string[]
  // Machine-derived tags for sessions the user hasn't tagged (sessionId → tag)
  autoTags: Record<string, string>

  // Archived sessions (GUI-only registry — Pi has no archive concept)
  archivedSessions: Record<string, number>
  showArchived: boolean

  // Notes (reusable prompts / commands)
  notes: Note[]
  notePickerOpen: boolean
  commandPaletteOpen: boolean
  commandPaletteQuery: string
  commandPaletteReplace: boolean
  // A prompt queued for insertion into the chat input. The nonce lets the
  // chat input re-apply the same text on repeated inserts.
  pendingInsert: { text: string; nonce: number; replace?: boolean } | null
  // Body text captured (e.g. from a message) to seed a new note in the Notes
  // panel. Non-null opens the panel's New Note form pre-filled.
  noteDraft: string | null

  // Update check (GitHub releases). Set when a newer version is available.
  updateInfo: UpdateCheckResult | null
  updateDismissed: boolean

  // Cross-session lineage tree
  lineage: LineageNode[]
}

interface AppActions {
  // Pi lifecycle
  startPi: (options?: Record<string, unknown>) => Promise<void>
  stopPi: () => Promise<void>
  restartPi: (options?: Record<string, unknown>) => Promise<void>

  // Messages
  addMessage: (message: DisplayMessage) => void
  setMessages: (messages: DisplayMessage[]) => void
  clearMessages: () => void

  // Prompts
  sendPrompt: (message: string, options?: { images?: PromptImage[]; attachments?: DisplayAttachment[] }) => Promise<void>
  sendSteer: (message: string) => Promise<void>
  sendFollowUp: (message: string) => Promise<void>
  runCouncil: (request: string) => Promise<void>
  approveCouncilPlan: () => Promise<void>
  reviseCouncilPlan: (feedback: string) => Promise<void>
  cancelCouncil: () => void
  abort: () => Promise<void>

  // Session
  createNewSession: () => Promise<void>
  switchSession: (path: string) => Promise<void>
  reloadActiveSession: () => Promise<void>
  refreshSessionState: () => Promise<void>
  refreshSessionStats: () => Promise<void>
  refreshSessionList: () => Promise<void>
  setSessionName: (name: string) => Promise<void>
  loadForkMessages: () => Promise<void>
  forkFrom: (entryId: string) => Promise<void>
  cloneBranch: () => Promise<void>

  // Model
  setModel: (provider: string, modelId: string) => Promise<void>
  cycleModel: () => Promise<void>
  listModels: () => Promise<void>

  // Thinking
  setThinkingLevel: (level: string) => Promise<void>
  cycleThinkingLevel: () => Promise<void>

  // Context compaction
  compactContext: () => Promise<void>

  // UI
  setCurrentView: (view: AppState['currentView']) => void
  setChatSidePanel: (panel: AppState['chatSidePanel']) => void
  toggleSidebar: () => void
  toggleTerminal: () => void
  loadSettings: () => Promise<void>
  setFontSizePreview: (patch: {
    ui?: number | null
    terminal?: number | null
    editor?: number | null
  }) => void
  setPermissionMode: (mode: PermissionMode) => Promise<void>
  toggleSessionGroupCollapsed: (projectPath: string) => Promise<void>
  loadCommands: () => Promise<void>

  // Events
  handlePiEvent: (event: PiRpcEvent) => void

  // Extension UI
  respondExtensionUi: (id: string, response: Record<string, unknown>) => void
  dismissExtensionUi: () => void

  // App confirmation dialog (promise-based; resolves true on confirm)
  requestConfirm: (options: ConfirmOptions) => Promise<boolean>
  resolveConfirm: (confirmed: boolean) => void

  // Workspaces
  loadWorkspaces: () => Promise<void>
  createWorkspace: (name: string, path: string) => Promise<void>
  switchWorkspace: (workspaceId: string) => Promise<void>
  removeWorkspace: (workspaceId: string) => Promise<void>
  renameWorkspace: (workspaceId: string, name: string) => Promise<void>
  changeWorkspaceFolder: (workspaceId: string, newPath: string) => Promise<void>

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

  // Custom models config
  loadCustomModels: () => Promise<void>
  saveCustomModels: (edited: ModelsConfig) => Promise<{ ok: boolean; errors?: string[] }>

  // File preview
  setSelectedFile: (relativePath: string | null, path: string | null) => void

  // File search
  toggleFileSearch: () => void

  // Session tags
  loadTags: () => Promise<void>
  addSessionTag: (sessionId: string, tag: string) => Promise<void>
  removeSessionTag: (sessionId: string, tag: string) => Promise<void>
  getTagsForSession: (sessionId: string) => string[]
  ensureAutoTags: (sessions: Array<{ sessionId: string; path: string }>) => Promise<void>
  removeAutoTag: (sessionId: string) => Promise<void>

  // Archive / delete
  loadArchivedSessions: () => Promise<void>
  archiveSession: (sessionId: string) => Promise<void>
  unarchiveSession: (sessionId: string) => Promise<void>
  deleteSession: (session: SessionListItem) => Promise<{ ok: boolean; method: 'trash' | 'unlink'; error?: string }>
  toggleShowArchived: () => void

  // Notes
  loadNotes: () => Promise<void>
  saveNote: (input: NoteInput) => Promise<void>
  updateNote: (id: string, patch: NoteUpdate) => Promise<void>
  deleteNote: (id: string) => Promise<void>
  insertPrompt: (text: string, replace?: boolean) => void
  clearPendingInsert: () => void
  setNotePickerOpen: (open: boolean) => void
  setCommandPalette: (open: boolean, query?: string, replace?: boolean) => void
  startNoteFromText: (text: string) => void
  clearNoteDraft: () => void

  // Update check
  checkForUpdates: () => Promise<void>
  dismissUpdate: () => void

  // Lineage
  loadLineage: () => Promise<void>
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

let messageCounter = 0
function generateId(): string {
  return `msg-${Date.now()}-${++messageCounter}`
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
  forkMessages: [],

  messages: [],
  streamingContent: '',
  streamingThinking: '',
  streamingToolCalls: new Map(),
  isStreaming: false,

  pendingSteering: [],
  pendingFollowUp: [],

  // Default to the Home/launcher view; useInitialize switches to 'chat' when
  // the openToHomeOnLaunch setting is off (legacy boot-into-chat behavior).
  currentView: 'home',
  chatSidePanel: null,
  sidebarOpen: true,
  terminalOpen: false,
  settings: null,
  uiFontSizePreview: null,
  terminalFontSizePreview: null,
  codeEditorFontSizePreview: null,
  commands: [],

  extensionUiRequest: null,
  confirmRequest: null,

  workspaces: [],
  activeWorkspace: null,

  timelineEvents: [],

  installedPackages: [],
  catalogPackages: [],
  packageLoading: false,
  packageSearchQuery: '',
  packageNotification: null,

  installedSkills: [],

  customModels: null,
  customModelsError: null,
  councilRun: null,

  selectedFile: null,

  fileSearchOpen: false,

  sessionTags: {},
  autoTags: {},
  allUsedTags: [],

  archivedSessions: {},
  showArchived: false,

  notes: [],
  notePickerOpen: false,
  commandPaletteOpen: false,
  commandPaletteQuery: '',
  commandPaletteReplace: true,
  pendingInsert: null,
  noteDraft: null,
  updateInfo: null,
  updateDismissed: false,

  lineage: [],

  // ─── Pi Lifecycle ─────────────────────────────────────────────────────

  startPi: async (options) => {
    // Don't start if already running
    if (get().piStatus === 'running') return

    try {
      const status = await window.piDesktop.pi.start(options as Record<string, unknown> | undefined)
      set({ piStatus: status.status, piPid: status.pid, piError: status.error })

      if (status.status === 'running') {
        await get().refreshSessionState()
        await get().refreshSessionStats()
        await get().refreshSessionList()
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
    const { piStatus, isStreaming, sessionState, settings } = get()

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
      attachments: options?.attachments,
    })

    set({ isStreaming: true, streamingContent: '', streamingThinking: '', streamingToolCalls: new Map() })

    try {
      if (isStreaming) {
        // Queue as steering during streaming, carrying any image attachments.
        await window.piDesktop.commands.steer(message, options?.images)
      } else {
        const prompt = settings?.permissionMode === 'plan-readonly'
          ? buildPlanningPrompt(message)
          : message
        await window.piDesktop.commands.prompt(prompt, options)
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

  runCouncil: async (request) => {
    const { piStatus, settings } = get()
    if (piStatus !== 'running' || !request.trim()) return
    const config = settings?.council
    if (!config) return

    set({ councilRun: { phase: 'detecting', request, results: [] } })

    const detectResult = await window.piDesktop.council.detect()
    const detected = { pi: false, claude: false, codex: false } as Record<CouncilAgentId, boolean>
    for (const a of detectResult.agents) detected[a.id] = a.found

    const resolution = resolveActiveMembers(config, detected)
    if (!resolution.canRun) {
      set({ councilRun: { phase: 'refused', request, results: [], reason: resolution.reason } })
      return
    }

    set({
      councilRun: {
        phase: 'consulting',
        request,
        results: [],
        members: resolution.active,
        partials: {},
        startedAt: Date.now(),
      },
    })

    // Stream live consultant output into councilRun.partials while consulting.
    const unsubscribe = window.piDesktop.council.onProgress(({ id, chunk }) => {
      const run = get().councilRun
      if (!run || run.phase !== 'consulting') return
      const partials = { ...(run.partials ?? {}) }
      partials[id] = (partials[id] ?? '') + chunk
      set({ councilRun: { ...run, partials } })
    })

    let results
    try {
      ;({ results } = await window.piDesktop.council.runConsultants({
        request,
        members: resolution.active,
        timeoutSeconds: config.timeoutSeconds,
        consensusMode: config.consensusMode,
      }))
    } finally {
      unsubscribe()
    }

    if (!hasQuorum(results)) {
      set({
        councilRun: {
          phase: 'refused',
          request,
          results,
          reason: 'No consultant produced a plan (all timed out or errored). Council aborted.',
        },
      })
      return
    }

    set({ councilRun: { phase: 'merging', request, results } })
    const consensusPrompt = buildConsensusPrompt(request, results)
    await get().sendPrompt(consensusPrompt)
    set({ councilRun: { phase: 'awaiting-approval', request, results } })
  },

  approveCouncilPlan: async () => {
    const run = get().councilRun
    if (!run || run.phase !== 'awaiting-approval') return
    set({ councilRun: null })
    await get().sendFollowUp('Approved. Implement the consensus plan above now.')
  },

  reviseCouncilPlan: async (feedback) => {
    const run = get().councilRun
    if (!run || run.phase !== 'awaiting-approval' || !feedback.trim()) return
    // Pi revises the consensus plan in-place; the run stays at the approval gate.
    await get().sendPrompt(buildRevisionPrompt(feedback))
  },

  cancelCouncil: () => set({ councilRun: null }),

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
          content: result.error ?? 'Cannot create session — Pi not running',
          timestamp: Date.now(),
        })
        return
      }
      get().clearMessages()
      await get().refreshSessionState()
      await get().refreshSessionStats()
      await get().refreshSessionList()
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
          content: result.error ?? 'Cannot switch session — Pi not running',
          timestamp: Date.now(),
        })
        return
      }
      await get().reloadActiveSession()
    } catch (err) {
      get().addMessage({
        id: generateId(),
        role: 'system',
        content: `Switch session error: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now(),
      })
    }
  },

  reloadActiveSession: async () => {
    get().clearMessages()
    get().refreshSessionState()
    get().refreshSessionStats()
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
    get().refreshSessionList()
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
      const sessionState = get().sessionState
      const activeWorkspace = get().activeWorkspace
      const hasActiveSession = sessionState?.sessionFile
        ? list.some((item) => item.path === sessionState.sessionFile || item.sessionId === sessionState.sessionId)
        : false

      const sessionList = hasActiveSession
        ? list
        : sessionState?.sessionFile
        ? [
            {
              path: sessionState.sessionFile,
              name: sessionState.sessionName,
              sessionId: sessionState.sessionId,
              lastModified: Date.now(),
              messageCount: sessionState.messageCount,
              projectPath: activeWorkspace?.path ?? '',
              projectName: activeWorkspace?.name ?? '',
            },
            ...list,
          ]
        : list

      set({ sessionList })
    } catch {
      // Silent failure
    }
  },

  setSessionName: async (name) => {
    try {
      await window.piDesktop.session.setName(name)
      // No manual refresh: Pi emits `session_info_changed` after setting the
      // name, and handlePiEvent applies it to the Current Session panel and the
      // Recent row — the same path used by auto-title extensions.
    } catch {
      // Silent failure
    }
  },

  loadForkMessages: async () => {
    try {
      const raw = await window.piDesktop.session.getForkMessages()
      set({ forkMessages: normalizeForkMessages(raw) })
    } catch {
      set({ forkMessages: [] })
    }
  },

  forkFrom: async (entryId) => {
    const result = (await window.piDesktop.session.fork(entryId)) as { success?: boolean } | null
    if (result?.success) {
      await get().reloadActiveSession()
    }
  },

  cloneBranch: async () => {
    const result = (await window.piDesktop.session.clone()) as { success?: boolean } | null
    if (result?.success) {
      await get().reloadActiveSession()
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

  compactContext: async () => {
    try {
      await window.piDesktop.session.compact()
      // compaction_start/end events drive the chat system messages; refresh
      // state + stats so the context-usage figures update afterwards.
      get().refreshSessionState()
      get().refreshSessionStats()
    } catch {
      // Silent failure
    }
  },

  // ─── UI ───────────────────────────────────────────────────────────────

  setCurrentView: (view) => set({ currentView: view }),
  setChatSidePanel: (panel) => set({ chatSidePanel: panel }),

  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),

  toggleTerminal: () => set((state) => ({ terminalOpen: !state.terminalOpen })),

  loadSettings: async () => {
    try {
      const settings = await window.piDesktop.settings.getAll()
      set({ settings })

      applyTheme(settings.theme)

      // Apply font size
      document.documentElement.style.fontSize = `${settings.fontSize}px`
    } catch {
      // Silent failure
    }
  },

  setFontSizePreview: (patch) =>
    set((state) => ({
      uiFontSizePreview:
        patch.ui !== undefined ? patch.ui : state.uiFontSizePreview,
      terminalFontSizePreview:
        patch.terminal !== undefined ? patch.terminal : state.terminalFontSizePreview,
      codeEditorFontSizePreview:
        patch.editor !== undefined ? patch.editor : state.codeEditorFontSizePreview,
    })),

  setPermissionMode: async (mode) => {
    const updated = await window.piDesktop.settings.save({ permissionMode: mode })
    set({ settings: updated })
    if (get().piStatus === 'running') {
      await get().restartPi()
    }
  },

  toggleSessionGroupCollapsed: async (projectPath) => {
    const current = get().settings?.collapsedSessionGroups ?? []
    const next = current.includes(projectPath)
      ? current.filter((p) => p !== projectPath)
      : [...current, projectPath]
    const updated = await window.piDesktop.settings.save({ collapsedSessionGroups: next })
    set({ settings: updated })
  },

  loadCommands: async () => {
    try {
      const raw = await window.piDesktop.piCommands.list()
      const commands: PiCommand[] = Array.isArray(raw)
        ? raw
            .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
            .map((c) => ({
              name: String(c.name ?? ''),
              description: String(c.description ?? ''),
              source: typeof c.source === 'string' ? c.source : 'extension',
            }))
            .filter((c) => c.name.length > 0)
        : []
      set({ commands })
    } catch {
      set({ commands: [] })
    }
  },

  // ─── Event Handling ───────────────────────────────────────────────────

  handlePiEvent: (event) => {
    switch (event.type) {
      case 'message_update':
        handleMessageUpdate(event as PiMessageUpdateEvent, set)
        break

      case 'message_end':
        handleTurnComplete(set, (event as { message?: Record<string, unknown> }).message)
        get().addTimelineEvent({
          id: generateId(),
          type: 'assistant_message',
          timestamp: Date.now(),
          title: 'Assistant response complete',
          status: 'success',
        })
        break

      case 'turn_end':
        handleTurnComplete(set, (event as { message?: Record<string, unknown> }).message)
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

      case 'session_info_changed': {
        // Live title update (auto-title extension, /name, or our rename).
        // Apply the new name directly to the active session's state + list row
        // so both the Current Session panel and its Recent row update instantly,
        // with no file read or RPC round-trip.
        const newName = (typeof event.name === 'string' && event.name.trim()) || null
        set((state) => {
          const activeFile = state.sessionState?.sessionFile ?? null
          return {
            sessionState: state.sessionState
              ? { ...state.sessionState, sessionName: newName }
              : state.sessionState,
            sessionList: activeFile
              ? state.sessionList.map((s) => (s.path === activeFile ? { ...s, name: newName } : s))
              : state.sessionList,
          }
        })
        break
      }

      case 'status_change': {
        const statusEvent = event as unknown as PiStatus
        set({
          piStatus: statusEvent.status,
          piPid: statusEvent.pid,
          piError: statusEvent.error,
        })
        if (statusEvent.status === 'running') {
          get().loadCommands()
          get().loadSkills()
        }
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

  requestConfirm: (options) =>
    new Promise<boolean>((resolve) => {
      // Resolve any dialog already open (treated as cancelled) before showing.
      const pending = get().confirmRequest
      if (pending) pending.resolve(false)
      set({ confirmRequest: { ...options, resolve } })
    }),

  resolveConfirm: (confirmed) => {
    const req = get().confirmRequest
    if (req) req.resolve(confirmed)
    set({ confirmRequest: null })
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
      // Re-sync Pi status from main: each workspace has its own PiRpcManager,
      // so the new active workspace's Pi may be in a different state than
      // what piStatus is currently showing. Without this, the `if running return`
      // guard in startPi() would skip starting the new active workspace's Pi.
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
      await get().refreshSessionList()
    } catch {
      // Silent failure
    }
  },

  changeWorkspaceFolder: async (workspaceId, newPath) => {
    try {
      await window.piDesktop.workspace.changePath(workspaceId, newPath)
      await get().loadWorkspaces()
    } catch (err) {
      get().addMessage({
        id: generateId(),
        role: 'system',
        content: `Change folder error: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now(),
      })
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
        set({ packageNotification: { type: 'success', message: `Installed ${spec}. Restart Pi to load it.` } })
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

  loadCustomModels: async () => {
    try {
      const result = await window.piDesktop.models.read()
      if ('error' in result) {
        set({ customModels: null, customModelsError: result.error })
      } else {
        set({ customModels: result.config, customModelsError: null })
      }
    } catch (err) {
      set({ customModels: null, customModelsError: err instanceof Error ? err.message : String(err) })
    }
  },

  saveCustomModels: async (edited) => {
    const errors = validateModelsConfig(edited)
    if (errors.length > 0) return { ok: false, errors }
    const original = get().customModels ?? { providers: {} }
    const merged = mergeModelsConfig(original, edited)
    const result = await window.piDesktop.models.write(merged)
    if (!result.success) return { ok: false, errors: [result.error ?? 'Write failed'] }
    await get().loadCustomModels()
    return { ok: true }
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
      const [allTags, usedTags, autoTags] = await Promise.all([
        window.piDesktop.tags.getAll(),
        window.piDesktop.tags.getAllUsed(),
        window.piDesktop.tags.autoGetAll(),
      ])
      set({ sessionTags: allTags, allUsedTags: usedTags, autoTags })
    } catch {
      // Silent failure
    }
  },

  addSessionTag: async (sessionId, tag) => {
    try {
      const tags = await window.piDesktop.tags.add(sessionId, tag)
      set((state) => {
        // A manual tag supersedes the auto-tag (backend drops it too).
        const { [sessionId]: _dropped, ...autoTags } = state.autoTags
        return {
          sessionTags: { ...state.sessionTags, [sessionId]: tags },
          autoTags,
        }
      })
      // Refresh used tags
      const usedTags = await window.piDesktop.tags.getAllUsed()
      set({ allUsedTags: usedTags })
    } catch {
      // Silent failure
    }
  },

  ensureAutoTags: async (sessions) => {
    try {
      const autoTags = await window.piDesktop.tags.autoEnsure(sessions)
      set({ autoTags })
    } catch {
      // Silent failure
    }
  },

  removeAutoTag: async (sessionId) => {
    try {
      await window.piDesktop.tags.autoRemove(sessionId)
      set((state) => {
        const { [sessionId]: _dropped, ...autoTags } = state.autoTags
        return { autoTags }
      })
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

  // ─── Notes ────────────────────────────────────────────────────────────

  loadNotes: async () => {
    try {
      const notes = await window.piDesktop.notes.list()
      set({ notes })
    } catch {
      // Silent failure — notes are non-critical
    }
  },

  saveNote: async (input) => {
    const note = await window.piDesktop.notes.create(input)
    set((state) => ({ notes: [...state.notes, note] }))
  },

  updateNote: async (id, patch) => {
    const updated = await window.piDesktop.notes.update(id, patch)
    set((state) => ({
      notes: state.notes.map((n) => (n.id === id ? updated : n)),
    }))
  },

  deleteNote: async (id) => {
    await window.piDesktop.notes.remove(id)
    set((state) => ({ notes: state.notes.filter((n) => n.id !== id) }))
  },

  insertPrompt: (text, replace = false) =>
    set({
      currentView: 'chat',
      notePickerOpen: false,
      pendingInsert: { text, nonce: Date.now(), replace },
    }),

  clearPendingInsert: () => set({ pendingInsert: null }),

  setNotePickerOpen: (open) => set({ notePickerOpen: open }),

  setCommandPalette: (open, query = '', replace = true) =>
    set({ commandPaletteOpen: open, commandPaletteQuery: query, commandPaletteReplace: replace }),

  startNoteFromText: (text) =>
    set({ noteDraft: text, notePickerOpen: false, currentView: 'notes' }),

  clearNoteDraft: () => set({ noteDraft: null }),

  // ─── Update check ─────────────────────────────────────────────────────

  checkForUpdates: async () => {
    try {
      const info = await window.piDesktop.updates.check()
      if (info.updateAvailable) set({ updateInfo: info, updateDismissed: false })
    } catch {
      // Silent — update check is best-effort
    }
  },

  dismissUpdate: () => set({ updateDismissed: true }),

  // ─── Lineage ──────────────────────────────────────────────────────────

  loadLineage: async () => {
    try {
      const records = await window.piDesktop.session.getLineage()
      set({ lineage: buildLineageTree(records) })
    } catch {
      set({ lineage: [] })
    }
  },
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
            startedAt: Date.now(),
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
              durationMs: existing.startedAt ? Date.now() - existing.startedAt : undefined,
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
  set: ZustandSet,
  message?: Record<string, unknown>
): void {
  set((state) => {
    const newMessages = [...state.messages]

    // Commit streaming content as assistant message
    if (state.streamingContent || state.streamingThinking || state.streamingToolCalls.size > 0) {
      const entries = Array.from(state.streamingToolCalls.entries())
      const toolCalls = entries.map(([id, tc]) => ({
        id,
        name: tc.name,
        arguments: tc.args,
        isExecuting: false,
        durationMs: tc.durationMs,
      }))

      // Prefer the model/provider Pi records on this specific message (the
      // authoritative source, robust to mid-turn model switches); fall back to
      // the currently-selected model when the event omits them.
      const activeModel = state.sessionState?.model
      const model = typeof message?.model === 'string' ? message.model : activeModel?.id
      const provider = typeof message?.provider === 'string' ? message.provider : activeModel?.provider
      newMessages.push({
        id: generateId(),
        role: 'assistant',
        content: state.streamingContent,
        timestamp: Date.now(),
        thinking: state.streamingThinking || undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        model,
        provider,
      })

      // Emit a standalone toolResult message per tool call so the live view
      // matches what reloading from history produces (Pi persists tool output
      // as separate toolResult messages, not folded into the assistant turn).
      for (const [id, tc] of entries) {
        if (!tc.result) continue
        newMessages.push({
          id: `${id}-result`,
          role: 'toolResult',
          content: tc.result,
          timestamp: Date.now(),
        })
      }
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
      startedAt: Date.now(),
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
      // Accumulate partial output into `result`; keep `args` as the real
      // arguments so the finalized tool-call badge shows the invocation.
      newMap.set(event.toolCallId, {
        ...existing,
        result: text || existing.result,
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
        result: resultText || existing.result,
        durationMs: existing.startedAt ? Date.now() - existing.startedAt : existing.durationMs,
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
