import { create } from 'zustand'
import { applyTheme, setUserThemes, watchSystemTheme } from './utils/theme'
import { buildPlanningPrompt } from './utils/planning-prompt'
import { parseAgentMessage, type DisplayAttachment, type DisplayMessage } from './message-parsing'
import type { PiCommand } from '../../shared/pi-command'
import { normalizeForkMessages, type ForkPoint } from '../../shared/fork-point'
import { buildLineageTree, type LineageNode } from '../../shared/session-lineage'
import { clampSidebarWidth } from '../../shared/sidebar-width'
import { workspaceNameFromFolderPath } from '../../shared/folder-drop'
import { pathsEqual } from '../../shared/path-compare'
import { validateModelsConfig, mergeModelsConfig, type ModelsConfig } from '../../shared/models-config'
import {
  resolveActiveMembers,
  hasQuorum,
  buildImplementationPrompt,
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
  PiMessageStartEvent,
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
  CouncilArbiterRequest,
  PermissionRule,
  PermissionRulesScope,
  PendingPromptCounts,
  WorkspaceActivityMap,
  WorkflowRunSummary,
  SessionRuntimeInfo,
  SessionLaunchTaskOptions,
} from '../../shared/ipc-contracts'

export type { DisplayAttachment, DisplayMessage } from './message-parsing'

// ─── Preview Target ──────────────────────────────────────────────────────────

/**
 * What the side-panel preview is currently showing. `code` opens the editor
 * (with a Source/Preview toggle for markdown & HTML); `image` opens the image
 * viewer. `path` is absolute; `relativePath` (code only) drives the editor.
 */
export interface PreviewTarget {
  kind: 'code' | 'image'
  name: string
  path: string
  relativePath?: string
}

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
  // The arbiter's consensus plan text: streamed live during 'merging', then the
  // final plan shown at 'awaiting-approval'. Produced by an isolated read-only
  // Pi subprocess, so untrusted consultant output never reaches the live session.
  consensus?: string
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

/** The actions that abandon the live turn, either by replacing the session or by leaving it. */
export type SessionChangeAction = 'switch' | 'new' | 'fork' | 'clone' | 'workspace' | 'changeFolder'

const discardWarning = (verb: string): string =>
  `Pi has not finished responding in this session. ${verb} stops it: whatever Pi already wrote ` +
  'to the session is kept, but the rest of the response — including any tool calls still ' +
  'running — is discarded.'

const SESSION_CHANGE_PROMPTS: Record<SessionChangeAction, { message: string; confirmLabel: string }> = {
  switch: { message: discardWarning('Opening another session'), confirmLabel: 'Switch anyway' },
  new: { message: discardWarning('Starting a new session'), confirmLabel: 'Start anyway' },
  fork: { message: discardWarning('Forking this session'), confirmLabel: 'Fork anyway' },
  clone: { message: discardWarning('Cloning this branch'), confirmLabel: 'Clone anyway' },
  // Leaving a workspace does not tear the session down — each workspace has its
  // own Pi process and nothing stops it. The turn keeps running in the
  // background: its output lands in the session file and is restored on
  // switch-back, and any blocking prompt it raises while the user is away is
  // held by the main process and re-shown when this workspace is active again.
  workspace: {
    message:
      'Pi has not finished responding in this session. It keeps working after you switch: ' +
      'the response is saved to the session and restored when you come back, and any ' +
      'prompt Pi raises while you are away is held and shown on your return.',
    confirmLabel: 'Switch anyway',
  },
  // Unlike a workspace switch, this restarts the workspace's Pi (its working
  // directory is bound at spawn), so the turn does not survive in the background.
  changeFolder: {
    message: discardWarning('Changing the project folder restarts Pi, which'),
    confirmLabel: 'Change anyway',
  },
}

/** Total prompts held for workspaces other than the active one (whose prompt is already on screen). */
export function countPromptsWaitingElsewhere(
  counts: PendingPromptCounts,
  activeWorkspaceId: string | null
): number {
  let total = 0
  for (const [workspaceId, count] of Object.entries(counts)) {
    if (workspaceId !== activeWorkspaceId) total += count
  }
  return total
}

/** Badge/status label for held prompts, e.g. "2 Pi prompts waiting". */
export function formatPromptsWaiting(count: number): string {
  return `${count} Pi prompt${count === 1 ? '' : 's'} waiting`
}

/**
 * The per-turn state left behind once a turn is over. `isStreaming` otherwise
 * only clears on `agent_end` / `turn_end`, so any path that ends a turn without
 * those events has to apply this or the chat keeps a streaming bubble that no
 * incoming event can close. Built fresh each call: the tool-call map is mutable
 * and must never be shared between turns.
 */
function idleTurnState(): Pick<
  AppState,
  | 'isStreaming'
  | 'streamingContent'
  | 'streamingThinking'
  | 'streamingToolCalls'
  | 'pendingSteering'
  | 'pendingFollowUp'
  | 'reattachedMidTurn'
> {
  return {
    isStreaming: false,
    streamingContent: '',
    streamingThinking: '',
    streamingToolCalls: new Map(),
    pendingSteering: [],
    pendingFollowUp: [],
    reattachedMidTurn: false,
  }
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
  // Live Pi runtimes keyed by runtime id. Several can share one project cwd.
  sessionRuntimes: Record<string, SessionRuntimeInfo>
  activeSessionRuntimeId: string | null
  forkMessages: ForkPoint[]

  // Messages
  messages: DisplayMessage[]
  // Shell-style recall of prompts sent this session (oldest→newest); reset per
  // session in clearMessages. Recorded raw (before attachment inlining).
  promptHistory: string[]
  streamingContent: string
  streamingThinking: string
  streamingToolCalls: Map<
    string,
    { name: string; args: string; result?: string; isExecuting: boolean; isError?: boolean; startedAt?: number; durationMs?: number }
  >
  isStreaming: boolean
  /**
   * The renderer attached to a turn already in flight (workspace switch-back
   * or notification click into a working workspace). The stream buffers only
   * hold what arrived after the attach, so the next turn boundary must
   * backfill from the session instead of trusting them.
   */
  reattachedMidTurn: boolean
  /** True while a session history load is in flight (switch/reload). */
  sessionLoading: boolean

  // Queue
  pendingSteering: string[]
  pendingFollowUp: string[]

  // UI
  currentView: 'home' | 'chat' | 'mission-control' | 'settings' | 'sessions' | 'timeline' | 'packages' | 'diff' | 'notes' | 'skills' | 'diagnostics'
  // Scope for the Sessions view: 'current' shows only the active workspace's
  // sessions, 'all' keeps every project's history visible. Entry points set it
  // (sidebar Sessions = current, View all / command palette = all); the panel's
  // toggle flips it live.
  sessionsScope: 'all' | 'current'
  workflowPanelOpen: boolean
  // When set, the workflow navigator only lists runs recorded for this Pi
  // session id (run.sessionId). null = no session scope.
  workflowPanelFilter: string | null
  // Project/workspace scope for the sidebar Activity entry. null = global.
  workflowPanelWorkspaceId: string | null
  // Bumped to request the chat scroll jump to the bottom (used when resuming a
  // session/workspace from Home). In-app session switches leave it untouched so
  // the chat restores each session's remembered scroll position instead.
  chatScrollBottomNonce: number
  // Chat side panel: which secondary view (file tree or diff) is open in
  // the chat workspace. Lifted into the store so it survives navigating
  // away from chat (e.g. into Settings) and back.
  chatSidePanel: 'files' | 'diff' | null
  sidebarOpen: boolean
  terminalOpen: boolean
  reviewOpen: boolean
  settings: AppSettings | null
  // Unsaved edits from the Settings panel (theme, piPath, permission mode,
  // toggles, font sizes). Overlaid on `settings` so the form reflects them on
  // reopen and they survive view switches; the terminal/editor read their font
  // sizes from here so unsaved changes apply on remount. Cleared on Save/Reset.
  settingsDraft: Partial<AppSettings>
  // Unsaved per-scope permission-rules edits from the Settings panel; survive
  // view switches like settingsDraft. null = no pending edits for that scope.
  permissionRulesDrafts: Record<PermissionRulesScope, PermissionRule[] | null>
  commands: PiCommand[]

  // Extension UI
  // Blocking dialog slot (select/confirm/input/editor). Main retains every
  // request it delivers here and replays it on demand (flushPendingPrompts),
  // so clearing this slot never loses the prompt.
  extensionUiRequest: PiExtensionUiRequest | null
  // Fire-and-forget notify toast. Its own slot so a toast can never clobber
  // an unanswered blocking dialog (and vice versa); both can be on screen.
  extensionNotify: PiExtensionUiRequest | null
  // Blocking prompts held by main per workspace id (zero entries omitted).
  pendingPromptCounts: PendingPromptCounts
  // Per-workspace background activity derived in main (idle entries omitted).
  workspaceActivity: WorkspaceActivityMap
  // Dynamic workflow runs read from the extension's persisted run journal.
  workflowRuns: WorkflowRunSummary[]
  // Extension status entries (setStatus fire-and-forget). Keyed by statusKey.
  extensionStatuses: Record<string, string>
  // Live subagent progress from tool_execution_update events (subagent tool).
  subagentProgress: Array<{
    toolCallId: string
    agent: string
    status: string
    task: string
    toolCount: number
    tokens: number
    turnCount?: number
    durationMs: number
    currentTool?: string
    /** Parallel/chain children when the tool streams a progress list. */
    children?: Array<{
      id: string
      agent: string
      status: string
      task: string
      toolCount: number
      tokens: number
      durationMs: number
      currentTool?: string
    }>
  }>

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
  packageLoading: boolean // install/remove operations (affects the Installed tab)
  catalogLoading: boolean // catalog crawl (Catalog tab only)
  packageNotification: { type: 'success' | 'error'; message: string } | null

  // Skills
  installedSkills: InstalledSkill[]

  // Custom models config (~/.pi/agent/models.json)
  customModels: ModelsConfig | null
  customModelsError: string | null

  // Council run UI state (null when no council run is active)
  councilRun: CouncilRunState | null

  // File preview. A single target drives the side-panel preview; `kind` selects
  // the viewer (code editor with Source/Preview toggle, or image viewer). `path`
  // is absolute (readable via readAttachment / file:// even outside the
  // workspace); `relativePath` drives the code editor's language + header.
  previewTarget: PreviewTarget | null

  // Mirror of the editor pane's unsaved-changes state. The buffer itself is
  // component-local; this flag is what lets store actions that would destroy
  // it (new preview target, diff pane, workspace switch) ask first.
  editorDirty: boolean

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
  taskLauncherOpen: boolean
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
  recordPrompt: (text: string) => void

  // Prompts
  sendPrompt: (message: string, options?: { images?: PromptImage[]; attachments?: DisplayAttachment[] }) => Promise<void>
  sendSteer: (message: string) => Promise<void>
  sendFollowUp: (message: string) => Promise<void>
  runCouncil: (request: string) => Promise<void>
  approveCouncilPlan: () => Promise<void>
  reviseCouncilPlan: (feedback: string) => Promise<void>
  cancelCouncil: () => void
  abort: () => Promise<void>
  confirmSessionChange: (action: SessionChangeAction) => Promise<boolean>

  // Session
  createNewSession: () => Promise<void>
  launchTask: (options: SessionLaunchTaskOptions) => Promise<boolean>
  switchSession: (path: string, projectPath?: string) => Promise<void>
  /**
   * Open a session row from any surface (sidebar, session panel, quick
   * switcher): auto-switches or creates the owning workspace first, then
   * switches to the session and shows Chat. The previous session runtime keeps
   * running in the background while the new one hydrates.
   */
  openSessionItem: (session: SessionListItem) => Promise<void>
  reloadActiveSession: (options?: { refreshList?: boolean }) => Promise<void>
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
  setSessionsScope: (scope: 'all' | 'current') => void
  setWorkflowPanelOpen: (open: boolean) => void
  openWorkflowRunsForSession: (sessionId: string) => void
  openWorkflowRunsForWorkspace: (workspaceId: string | null) => void
  refreshWorkflowRuns: () => Promise<void>
  requestChatScrollToBottom: () => void
  // Resolves false when a dirty-editor discard was declined (diff pane only).
  setChatSidePanel: (panel: AppState['chatSidePanel']) => Promise<boolean>
  toggleSidebar: () => void
  toggleTerminal: () => void
  toggleReview: () => void
  loadSettings: () => Promise<void>
  setSettingsDraft: (patch: Partial<AppSettings>) => void
  clearSettingsDraft: () => void
  setPermissionRulesDraft: (scope: PermissionRulesScope, rules: PermissionRule[] | null) => void
  setPermissionMode: (mode: PermissionMode) => Promise<void>
  toggleSessionGroupCollapsed: (projectPath: string) => Promise<void>
  saveSidebarWidth: (width: number) => Promise<void>
  loadCommands: () => Promise<void>

  // Events
  handlePiEvent: (event: PiRpcEvent) => void
  handlePendingPromptCounts: (counts: PendingPromptCounts) => void
  handleWorkspaceActivity: (map: WorkspaceActivityMap) => void
  handleSessionRuntime: (runtime: SessionRuntimeInfo) => void
  /**
   * Boot/reload recovery: the dialog slot and the counts are renderer memory
   * only, while main keeps every held prompt. Pulls the counts snapshot and
   * asks main to re-broadcast the active workspace's dialog. Never rejects.
   */
  recoverPendingPrompts: () => Promise<void>

  // Extension UI
  respondExtensionUi: (id: string, response: Record<string, unknown>) => void
  dismissExtensionUi: () => void
  dismissExtensionNotify: () => void

  // App confirmation dialog (promise-based; resolves true on confirm)
  requestConfirm: (options: ConfirmOptions) => Promise<boolean>
  resolveConfirm: (confirmed: boolean) => void

  // Shows the one-time "this workspace has its own permission rules" notice
  // and records the acknowledgment in settings.
  maybeWarnWorkspacePermissionRules: () => Promise<void>

  // Workspaces
  loadWorkspaces: () => Promise<void>
  createWorkspace: (name: string, path: string) => Promise<void>
  /** Create a clean Git worktree and start it as a new independent tab. */
  createWorktreeTab: () => Promise<void>
  /**
   * Open a folder as a workspace (create if needed, switch into it, show Chat).
   * Used by File → Open Project and by drag-dropping a folder onto the window.
   * Resolves false if the editor discard was declined or the switch failed.
   */
  openFolderAsWorkspace: (folderPath: string) => Promise<boolean>
  /**
   * Resolves false when the editor discard was declined or the switch failed.
   * Workspace tabs keep their Pi processes running in the background.
   * skipSessionLoad: when opening a specific session next, skip resume+history —
   * switchSession will load the target once.
   */
  activateWorkspace: (workspaceId: string, options?: { start?: boolean }) => Promise<boolean>
  switchWorkspace: (
    workspaceId: string,
    options?: { skipSessionLoad?: boolean }
  ) => Promise<boolean>
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
  loadCatalog: () => Promise<void>
  clearPackageNotification: () => void

  // Skills
  loadSkills: () => Promise<void>

  // Custom models config
  loadCustomModels: () => Promise<void>
  saveCustomModels: (edited: ModelsConfig) => Promise<{ ok: boolean; errors?: string[] }>

  // File preview. Resolves false when a dirty-editor discard was declined and
  // the target was left unchanged.
  setPreviewTarget: (target: PreviewTarget | null) => Promise<boolean>
  setEditorDirty: (dirty: boolean) => void
  // True when the caller may proceed to destroy the editor's unsaved buffer.
  confirmDiscardEditorChanges: () => Promise<boolean>

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
  setCommandPalette: (open: boolean) => void
  setTaskLauncherOpen: (open: boolean) => void
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

// Bumps on every session switch / explicit reload so in-flight getMessages
// results from a previous switch are dropped instead of fighting the UI.
let sessionLoadGeneration = 0

/**
 * Texts of prompts this GUI just sent to Pi, awaiting their echo on the RPC
 * event stream. Pi emits a `message_start` for every user message added to
 * the session — both ours and ones injected inside the Pi process by
 * extensions (e.g. pi-nvim's socket bridge). Externally injected prompts must
 * be rendered from that event or they never appear in the thread; our own
 * prompts must be skipped, since sendPrompt already adds the bubble locally
 * at send time. Entries expire so a prompt whose echo never arrives (send
 * failure, process restart) cannot swallow an identical future external
 * message.
 */
const pendingLocalEchoes: { text: string; sentAt: number }[] = []
const LOCAL_ECHO_TTL_MS = 5 * 60 * 1000
const LOCAL_ECHO_MAX = 50

function recordLocalEcho(text: string): void {
  pendingLocalEchoes.push({ text, sentAt: Date.now() })
  if (pendingLocalEchoes.length > LOCAL_ECHO_MAX) pendingLocalEchoes.shift()
}

/** Consume the oldest pending local echo matching this content, if any. */
function consumeLocalEcho(text: string): boolean {
  const now = Date.now()
  for (let i = pendingLocalEchoes.length - 1; i >= 0; i--) {
    if (now - pendingLocalEchoes[i].sentAt > LOCAL_ECHO_TTL_MS) pendingLocalEchoes.splice(i, 1)
  }
  const idx = pendingLocalEchoes.findIndex((entry) => entry.text === text)
  if (idx === -1) return false
  pendingLocalEchoes.splice(idx, 1)
  return true
}

// Latest path requested for switch — rapid clicks only run the final one.
let pendingSwitchPath: string | null = null
let switchCoalesceTimer: ReturnType<typeof setTimeout> | null = null
/** Resolve for the in-flight coalesce wait — invoked immediately when superseded. */
let switchCoalesceResolve: (() => void) | null = null
// Only one get_messages/switch pipeline at a time (Pi + IPC can't keep up).
let switchPipeline: Promise<void> = Promise.resolve()

// Attach backfills ride the same pipeline as session switches so their
// get_messages can never run concurrently with a switch's (each response is a
// multi-MB IPC clone, and an agent_end landing inside a switch's coalesce
// window would otherwise race it). Generation checks inside
// reloadActiveSession still drop a backfill a newer switch superseded.
function enqueueAttachBackfill(get: () => AppState & AppActions): Promise<void> {
  const load = (): Promise<void> => get().reloadActiveSession({ refreshList: false })
  switchPipeline = switchPipeline.then(load, load)
  return switchPipeline
}

// Coalesce filesystem session-list walks: rapid switches used to stack N full
// directory scans and freeze the renderer/main.
let sessionListRefreshInFlight = false
let sessionListRefreshQueued = false
let sessionListRefreshTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Adopt an active-workspace change the main process made on its own: creating a
 * workspace whose path is already registered activates the existing one, as does
 * creating the very first workspace, and removing the active one promotes
 * another. None of those go through switchWorkspace, so the renderer has to
 * resync the extension-UI surfaces here or a prompt held for the workspace now
 * on screen stays invisible — the badge counts other workspaces only — and its
 * Pi turn blocks forever.
 *
 * The stale dialog is cleared WITHOUT answering: main retains the request and
 * replays it on switch-back, while a synthesized deny would hard-block the tool
 * that asked.
 */
function adoptMainSideActivation(
  get: () => AppState & AppActions,
  set: (partial: Partial<AppState>) => void,
  previousActiveId: string | null
): void {
  const active = get().activeWorkspace
  if (active?.id === previousActiveId) return

  // The preview and chat belong to the workspace that just disappeared or was
  // activated by main. Reset them before attaching the replacement manager;
  // otherwise closing the active tab leaves the old conversation on screen.
  sessionLoadGeneration += 1
  set({
    extensionUiRequest: null,
    previewTarget: null,
    editorDirty: false,
    sessionState: null,
    sessionStats: null,
    activeSessionRuntimeId: null,
    timelineEvents: [],
    piStatus: 'stopped',
    piPid: null,
    piError: null,
    ...idleTurnState(),
  })
  if (!active) return

  void window.piDesktop.ui.flushPendingPrompts(active.id)
  // A main-side activation is used by workspace removal and first-workspace
  // creation, neither of which goes through switchWorkspace's normal Pi start.
  // Start the promoted workspace when there was a previous active workspace;
  // the first-workspace open flow starts it through its regular switch path.
  if (previousActiveId !== null) {
    void get().startPi().then(() => {
      if (get().activeWorkspace?.id !== active.id || get().piStatus !== 'running') return
      void get().reloadActiveSession()
    })
  }
}

function scheduleSessionListRefresh(get: () => AppState & AppActions): void {
  if (sessionListRefreshTimer) clearTimeout(sessionListRefreshTimer)
  sessionListRefreshTimer = setTimeout(() => {
    sessionListRefreshTimer = null
    void get().refreshSessionList()
  }, 250)
}

const PARSE_CHUNK = 50

/** Parse history in chunks, yielding to the event loop so the UI can paint. */
async function parseMessagesChunked(
  raw: unknown[],
  gen: number
): Promise<DisplayMessage[] | null> {
  const out: DisplayMessage[] = []
  for (let i = 0; i < raw.length; i += PARSE_CHUNK) {
    if (gen !== sessionLoadGeneration) return null
    const end = Math.min(i + PARSE_CHUNK, raw.length)
    for (let j = i; j < end; j++) {
      const parsed = parseAgentMessage(raw[j])
      if (parsed) out.push(parsed)
    }
    // Yield so Windows doesn't mark the window "Not Responding".
    await new Promise<void>((r) => setTimeout(r, 0))
  }
  if (gen !== sessionLoadGeneration) return null
  return out
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

type CouncilStoreGet = () => AppState & AppActions
type CouncilStoreSet = (partial: Partial<AppState & AppActions>) => void

interface ArbiterStepBase {
  request: string
  results: ConsultantResult[]
}

/**
 * Drive one arbiter round (merge or revise) through the isolated read-only Pi
 * subprocess, streaming its output live into councilRun.consensus. Returns the
 * final plan text, or an error string if the arbiter failed. Callers own the
 * resulting phase transition.
 */
async function runArbiterStep(
  payload: CouncilArbiterRequest,
  base: ArbiterStepBase,
  get: CouncilStoreGet,
  set: CouncilStoreSet,
): Promise<{ plan?: string; error?: string }> {
  set({ councilRun: { phase: 'merging', request: base.request, results: base.results, consensus: '' } })
  const unsubscribe = window.piDesktop.council.onProgress(({ chunk }) => {
    const run = get().councilRun
    if (!run || run.phase !== 'merging') return
    set({ councilRun: { ...run, consensus: (run.consensus ?? '') + chunk } })
  })
  try {
    const { plan } = await window.piDesktop.council.arbiter(payload)
    return { plan }
  } catch (err) {
    return { error: `Arbiter failed: ${err instanceof Error ? err.message : String(err)}` }
  } finally {
    unsubscribe()
  }
}

export const useAppStore = create<AppState & AppActions>((set, get) => ({
  // ─── Initial State ────────────────────────────────────────────────────

  piStatus: 'stopped',
  piPid: null,
  piError: null,

  sessionState: null,
  sessionStats: null,
  sessionList: [],
  sessionRuntimes: {},
  activeSessionRuntimeId: null,
  forkMessages: [],

  messages: [],
  promptHistory: [],
  streamingContent: '',
  streamingThinking: '',
  streamingToolCalls: new Map(),
  isStreaming: false,
  reattachedMidTurn: false,
  sessionLoading: false,

  pendingSteering: [],
  pendingFollowUp: [],

  // Default to the Home/launcher view; useInitialize switches to 'chat' when
  // the openToHomeOnLaunch setting is off (legacy boot-into-chat behavior).
  currentView: 'home',
  sessionsScope: 'all',
  workflowPanelOpen: false,
  workflowPanelFilter: null,
  workflowPanelWorkspaceId: null,
  chatScrollBottomNonce: 0,
  chatSidePanel: null,
  sidebarOpen: true,
  terminalOpen: false,
  reviewOpen: false,
  settings: null,
  settingsDraft: {},
  permissionRulesDrafts: { global: null, workspace: null },
  commands: [],

  extensionUiRequest: null,
  extensionNotify: null,
  pendingPromptCounts: {},
  workspaceActivity: {},
  workflowRuns: [],
  extensionStatuses: {},
  subagentProgress: [],
  confirmRequest: null,

  workspaces: [],
  activeWorkspace: null,

  timelineEvents: [],

  installedPackages: [],
  catalogPackages: [],
  packageLoading: false,
  catalogLoading: false,
  packageNotification: null,

  installedSkills: [],

  customModels: null,
  customModelsError: null,
  councilRun: null,

  previewTarget: null,
  editorDirty: false,

  fileSearchOpen: false,

  sessionTags: {},
  autoTags: {},
  allUsedTags: [],

  archivedSessions: {},
  showArchived: false,

  notes: [],
  notePickerOpen: false,
  commandPaletteOpen: false,
  taskLauncherOpen: false,
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
        await get().maybeWarnWorkspacePermissionRules()
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

      // Re-read session state after a restart so the status bar's model label
      // and stats reflect a changed models.json (mirrors startPi). Without this
      // the label keeps the pre-restart model.
      if (status.status === 'running') {
        await get().refreshSessionState()
        await get().refreshSessionStats()
        await get().refreshSessionList()
      }
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

  // Tears down the whole chat context. The turn being left behind ends with it,
  // so its streaming state and queue counters go too — otherwise the newly
  // loaded session inherits a stuck spinner and a stale "queued steers" badge.
  clearMessages: () =>
    set({ messages: [], promptHistory: [], subagentProgress: [], ...idleTurnState() }),

  // Append a sent prompt to the recall history. Ignores blanks and consecutive
  // duplicates (shell-style), and caps the list so it can't grow unbounded.
  recordPrompt: (text) =>
    set((state) => {
      const trimmed = text.trim()
      if (!trimmed) return state
      const history = state.promptHistory
      if (history[history.length - 1] === trimmed) return state
      const next = [...history, trimmed]
      if (next.length > 200) next.shift()
      return { promptHistory: next }
    }),

  // ─── Prompts ──────────────────────────────────────────────────────────

  sendPrompt: async (message, options) => {
    const trimmed = message.trim().toLowerCase()
    if (trimmed === '/workflow' || trimmed === '/workflows') {
      // Route through the action so a session-scoped filter can never leak
      // into the global view opened from chat.
      get().setWorkflowPanelOpen(true)
      return
    }
    if (trimmed.startsWith('/workflows run ')) get().setWorkflowPanelOpen(true)

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
        recordLocalEcho(message)
        await window.piDesktop.commands.steer(message, options?.images)
      } else {
        const prompt = settings?.permissionMode === 'plan-readonly'
          ? buildPlanningPrompt(message)
          : message
        // Record the text actually sent (plan mode wraps it), not the text
        // displayed — Pi's message_start echo carries the sent form.
        recordLocalEcho(prompt)
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
      // Steers are intentionally not rendered as bubbles; record the echo so
      // the message_start handler does not render one as an external prompt.
      recordLocalEcho(message)
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
      // Same as sendSteer: suppress the echo-rendered external bubble.
      recordLocalEcho(message)
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

    // The arbiter runs in an isolated read-only Pi subprocess. Consultant plans
    // are untrusted input, so they are never fed to the live (writable) session —
    // only the vetted consensus plan is, and only after the user approves it.
    const merged = await runArbiterStep(
      { kind: 'merge', request, results, timeoutSeconds: config.timeoutSeconds },
      { request, results },
      get,
      set,
    )
    if (merged.error) {
      set({ councilRun: { phase: 'refused', request, results, reason: merged.error } })
      return
    }
    set({ councilRun: { phase: 'awaiting-approval', request, results, consensus: merged.plan } })
  },

  approveCouncilPlan: async () => {
    const run = get().councilRun
    if (!run || run.phase !== 'awaiting-approval' || !run.consensus?.trim()) return
    const plan = run.consensus
    set({ councilRun: null })
    // Only the approved plan crosses into the writable session — never raw
    // consultant output — so it cannot drive tools before this approval gate.
    await get().sendPrompt(buildImplementationPrompt(plan))
  },

  reviseCouncilPlan: async (feedback) => {
    const run = get().councilRun
    if (!run || run.phase !== 'awaiting-approval' || !feedback.trim() || !run.consensus) return
    const { request, results, consensus } = run
    const config = get().settings?.council
    if (!config) return
    const revised = await runArbiterStep(
      { kind: 'revise', request, plan: consensus, feedback, timeoutSeconds: config.timeoutSeconds },
      { request, results },
      get,
      set,
    )
    if (revised.error) {
      // Keep the previous plan at the approval gate and surface the failure.
      set({ councilRun: { phase: 'awaiting-approval', request, results, consensus, reason: revised.error } })
      return
    }
    set({ councilRun: { phase: 'awaiting-approval', request, results, consensus: revised.plan } })
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

  // Gate destructive actions that still replace or discard work in the active
  // runtime. Session navigation itself is deliberately not included: every
  // session owns a separate Pi process, so leaving it running is safe.
  //
  // Must be consulted BEFORE anything calls clearMessages(): that resets
  // `isStreaming`, which is the signal this gate reads.
  confirmSessionChange: async (action) => {
    if (!get().isStreaming) return true
    const { message, confirmLabel } = SESSION_CHANGE_PROMPTS[action]
    return get().requestConfirm({
      title: 'Pi is still working',
      message,
      confirmLabel,
      cancelLabel: 'Keep working',
      // Discards work in progress, so the confirm button reads as destructive and
      // "Keep working" takes the initial focus.
      danger: true,
    })
  },

  // ─── Session ──────────────────────────────────────────────────────────

  createNewSession: async () => {
    const gen = ++sessionLoadGeneration
    try {
      // A new session owns a new Pi process. Never stop or warn about the
      // session the user is leaving; it continues working in the background.
      const result = await window.piDesktop.session.createNew() as SessionRuntimeInfo | { success?: boolean; error?: string } | null
      if (gen !== sessionLoadGeneration) return
      if (result && 'success' in result && result.success === false) {
        get().addMessage({
          id: generateId(),
          role: 'system',
          content: result.error ?? 'Cannot create session',
          timestamp: Date.now(),
        })
        set(idleTurnState())
        return
      }
      get().clearMessages()
      const runtime = result && 'runtimeId' in result ? result : null
      set({
        currentView: 'chat',
        sessionState: null,
        sessionStats: null,
        sessionLoading: runtime?.status !== 'running',
        ...(runtime ? {
          activeSessionRuntimeId: runtime.runtimeId,
          piStatus: runtime.status,
          piPid: runtime.pid,
          piError: runtime.error,
        } : {}),
      })
      // The runtime start is intentionally asynchronous. Its runtime event
      // hydrates this empty chat once Pi is ready.
      scheduleSessionListRefresh(get)
    } catch (err) {
      if (gen !== sessionLoadGeneration) return
      get().addMessage({
        id: generateId(),
        role: 'system',
        content: `New session error: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now(),
      })
    }
  },

  launchTask: async (options) => {
    const prompt = options.prompt.trim()
    if (!prompt) return false
    let workspaceId = options.workspaceId
    let gen = 0
    try {
      if (get().activeWorkspace?.id !== workspaceId) {
        if (!(await get().activateWorkspace(workspaceId, { start: false }))) return false
      }
      if (options.isolated) {
        const label = prompt.split(/\r?\n/, 1)[0]?.trim().slice(0, 60) || 'Task'
        const workspace = await window.piDesktop.workspace.createTab({
          name: label,
          sourceWorkspaceId: workspaceId,
          startPi: false,
        })
        await get().loadWorkspaces()
        if (!(await get().activateWorkspace(workspace.id, { start: false }))) return false
        workspaceId = workspace.id
      }

      gen = ++sessionLoadGeneration
      const runtime = await window.piDesktop.session.launchTask({
        workspaceId,
        prompt,
      })
      if (gen !== sessionLoadGeneration) return false
      get().clearMessages()
      set({
        currentView: 'chat',
        sessionState: null,
        sessionStats: null,
        sessionLoading: true,
        activeSessionRuntimeId: runtime.runtimeId,
        piStatus: runtime.status === 'stopped' ? 'starting' : runtime.status,
        piPid: runtime.pid,
        piError: runtime.error,
      })
      scheduleSessionListRefresh(get)
      return true
    } catch (err) {
      if (gen !== 0 && gen !== sessionLoadGeneration) return false
      get().addMessage({
        id: generateId(),
        role: 'system',
        content: `Task launch error: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now(),
      })
      set({ sessionLoading: false })
      return false
    }
  },

  switchSession: async (path, projectPath) => {
    // Already on this session — avoid a full history reload. The explicit
    // sessionLoading check still handles a fast workspace switch that cleared
    // the view before the target runtime was bound.
    if (
      get().sessionState?.sessionFile === path &&
      !get().sessionLoading &&
      get().messages.length > 0
    ) {
      return
    }

    // Coalesce rapid clicks: only the last target starts hydration.
    pendingSwitchPath = path
    const gen = ++sessionLoadGeneration
    if (switchCoalesceTimer) {
      clearTimeout(switchCoalesceTimer)
      switchCoalesceTimer = null
    }
    if (switchCoalesceResolve) {
      const prev = switchCoalesceResolve
      switchCoalesceResolve = null
      prev()
    }
    await new Promise<void>((resolve) => {
      switchCoalesceResolve = resolve
      switchCoalesceTimer = setTimeout(() => {
        switchCoalesceTimer = null
        switchCoalesceResolve = null
        resolve()
      }, 40)
    })
    if (gen !== sessionLoadGeneration || pendingSwitchPath !== path) return

    const run = async (): Promise<void> => {
      if (gen !== sessionLoadGeneration || pendingSwitchPath !== path) return
      try {
        // Binding a different session is safe: its Pi process continues in the
        // background. Render the new target immediately; only hydration waits.
        set({
          sessionLoading: true,
          sessionState: null,
          sessionStats: null,
          activeSessionRuntimeId: null,
        })
        get().clearMessages()
        const result = await window.piDesktop.session.switch(path, projectPath) as SessionRuntimeInfo | { success?: boolean; error?: string } | null
        if (gen !== sessionLoadGeneration) return
        if (result && 'success' in result && result.success === false) {
          set({ sessionLoading: false, ...idleTurnState() })
          get().addMessage({
            id: generateId(),
            role: 'system',
            content: result.error ?? 'Cannot activate session',
            timestamp: Date.now(),
          })
          return
        }
        const runtime = result && 'runtimeId' in result ? result : null
        if (get().activeWorkspace?.id) void window.piDesktop.ui.flushPendingPrompts(get().activeWorkspace!.id)
        set({
          currentView: 'chat',
          sessionLoading: runtime?.status !== 'running',
          ...(runtime ? {
            activeSessionRuntimeId: runtime.runtimeId,
            piStatus: runtime.status,
            piPid: runtime.pid,
            piError: runtime.error,
          } : {}),
        })
        // If the runtime is already ready this starts hydration now. If it is
        // still starting, handleSessionRuntime retries on its running event.
        void get().reloadActiveSession({ refreshList: false })
        scheduleSessionListRefresh(get)
      } catch (err) {
        if (gen !== sessionLoadGeneration) return
        set({ sessionLoading: false, ...idleTurnState() })
        get().addMessage({
          id: generateId(),
          role: 'system',
          content: `Switch session error: ${err instanceof Error ? err.message : String(err)}`,
          timestamp: Date.now(),
        })
      }
    }

    switchPipeline = switchPipeline.then(run, run)
    await switchPipeline
  },

  reloadActiveSession: async (options) => {
    const gen = sessionLoadGeneration
    const refreshList = options?.refreshList ?? true

    get().clearMessages()
    set({ sessionLoading: true })
    void get().refreshSessionState()
    void get().refreshSessionStats()

    try {
      const response = await window.piDesktop.session.getMessages()
      // A newer switch/reload started while we waited — discard this history.
      if (gen !== sessionLoadGeneration) return

      if (response && typeof response === 'object') {
        const resp = response as {
          success?: boolean
          data?: {
            messages?: unknown[]
            truncatedFromStart?: boolean
            totalMessageCount?: number
          }
        }
        if (resp.success && resp.data?.messages) {
          const rawMessages = resp.data.messages as unknown[]
          const shippedCount = rawMessages.length
          const loaded = await parseMessagesChunked(rawMessages, gen)
          if (loaded === null || gen !== sessionLoadGeneration) return
          const truncated = resp.data.truncatedFromStart === true
          const total = typeof resp.data.totalMessageCount === 'number' ? resp.data.totalMessageCount : shippedCount
          // Surface a one-line notice when older turns were dropped for perf.
          // Use the raw shipped count (not parse survivors) for "latest N of M".
          if (truncated && shippedCount > 0) {
            loaded.unshift({
              id: generateId(),
              role: 'system',
              content: `Showing the latest ${shippedCount} of ${total} messages for performance. Older turns are still on disk in the session file.`,
              timestamp: Date.now(),
            })
          }
          set({ messages: loaded, sessionLoading: false })
        } else {
          set({ sessionLoading: false })
        }
      } else {
        set({ sessionLoading: false })
      }
      if (refreshList) scheduleSessionListRefresh(get)
    } catch {
      if (gen === sessionLoadGeneration) set({ sessionLoading: false })
    }
  },

  openSessionItem: async (session) => {
    // Auto-switch workspace if the session is from a different project. Skip
    // the resume+history load — switchSession below loads the target session
    // once. Paths are compared the way main compares them (case-insensitive on
    // Windows): a casing mismatch here would route an existing workspace down
    // the create path, which main turns into a silent activation.
    const { activeWorkspace, workspaces } = get()
    const projectPath = session.projectPath
    if (projectPath && !(activeWorkspace && pathsEqual(activeWorkspace.path, projectPath))) {
      const matchingWs = workspaces.find((w) => pathsEqual(w.path, projectPath))
      if (matchingWs) {
        if (!(await get().activateWorkspace(matchingWs.id, { start: false }))) return
      } else {
        await get().createWorkspace(session.projectName, projectPath)
        const newWs = get().workspaces.find((w) => pathsEqual(w.path, projectPath))
        if (newWs && !(await get().activateWorkspace(newWs.id, { start: false }))) return
      }
    }
    // switchSession's working-workspace guard covers the live-turn cases from
    // here on: the turn's own session re-attaches instead of switching, and
    // opening a different session of a mid-turn workspace warns first.
    await get().switchSession(session.path, projectPath)
    // Bring the chat into view (may be on Settings/Notes/etc.). In-app
    // switches keep their remembered scroll position, so no force-to-bottom.
    get().setCurrentView('chat')
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
    if (sessionListRefreshInFlight) {
      sessionListRefreshQueued = true
      return
    }
    sessionListRefreshInFlight = true
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
              // The active session's first message is not on `sessionState`, and
              // the renderer cannot read the file; the row falls back to its name
              // or timestamp until the next list refresh supplies a preview.
              preview: null,
              sessionId: sessionState.sessionId,
              piSessionId: sessionState.sessionId,
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
    } finally {
      sessionListRefreshInFlight = false
      if (sessionListRefreshQueued) {
        sessionListRefreshQueued = false
        void get().refreshSessionList()
      }
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
    if (!(await get().confirmSessionChange('fork'))) return
    const result = (await window.piDesktop.session.fork(entryId)) as { success?: boolean } | null
    if (result?.success) {
      await get().reloadActiveSession()
    }
  },

  cloneBranch: async () => {
    if (!(await get().confirmSessionChange('clone'))) return
    const result = (await window.piDesktop.session.clone()) as { success?: boolean } | null
    if (result?.success) {
      await get().reloadActiveSession()
    }
  },

  // ─── Model ────────────────────────────────────────────────────────────

  setModel: async (provider, modelId) => {
    try {
      await window.piDesktop.model.set(provider, modelId)
      // Remember for next Pi start / home composer (settings defaults).
      try {
        const updated = await window.piDesktop.settings.save({
          defaultProvider: provider,
          defaultModel: modelId,
        })
        set({ settings: updated })
      } catch {
        // Non-fatal — model still applied for this session.
      }
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
  // Lifted into the store so the scope survives SessionPanel remounts (it
  // unmounts on every navigation) and so sidebar entry points can set it.
  setSessionsScope: (scope) => set({ sessionsScope: scope }),
  // A direct global entry point (slash command) clears project/session scope.
  // Closing merely hides the panel and PRESERVES the scope so a reopen stays in
  // the same project or session.
  setWorkflowPanelOpen: (open) =>
    set((state) => ({
      workflowPanelOpen: open,
      workflowPanelFilter: open ? null : state.workflowPanelFilter,
      workflowPanelWorkspaceId: open ? null : state.workflowPanelWorkspaceId,
    })),
  openWorkflowRunsForSession: (sessionId) => set({
    workflowPanelOpen: true,
    workflowPanelFilter: sessionId,
    workflowPanelWorkspaceId: null,
  }),
  // Project/workspace scope for the sidebar Activity entry. null = global.
  // The signature is null-widened: the Tools entry opens the global list with
  // an explicit null (the same value a direct global open falls back to).
  openWorkflowRunsForWorkspace: (workspaceId: string | null) => set({
    workflowPanelOpen: true,
    workflowPanelFilter: null,
    workflowPanelWorkspaceId: workspaceId,
  }),
  refreshWorkflowRuns: async () => {
    try {
      const workflowRuns = await window.piDesktop.workflows.list()
      set({ workflowRuns })
    } catch {
      set({ workflowRuns: [] })
    }
  },
  requestChatScrollToBottom: () =>
    set((state) => ({ chatScrollBottomNonce: state.chatScrollBottomNonce + 1 })),
  setChatSidePanel: async (panel) => {
    // Only opening the diff destroys the editor buffer: chat-panel renders the
    // editor pane only while the side panel is not 'diff', so this unmounts a
    // dirty FilePreview. Every other panel leaves the editor mounted.
    if (panel === 'diff') {
      if (!(await get().confirmDiscardEditorChanges())) return false
      set({ chatSidePanel: panel, editorDirty: false })
      return true
    }
    set({ chatSidePanel: panel })
    return true
  },

  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),

  toggleTerminal: () => set((state) => ({ terminalOpen: !state.terminalOpen })),

  toggleReview: () => set((state) => ({ reviewOpen: !state.reviewOpen })),

  loadSettings: async () => {
    try {
      const settings = await window.piDesktop.settings.getAll()
      set({ settings })

      const { themes, warnings } = await window.piDesktop.themes.list()
      for (const warning of warnings) {
        console.warn(warning)
      }
      setUserThemes(themes)

      applyTheme(settings.theme)
      // Re-apply on OS light/dark changes while the app is open, but only
      // when the effective (draft or saved) theme is 'system'.
      watchSystemTheme(() => {
        const state = get()
        return state.settingsDraft.theme ?? state.settings?.theme ?? 'system'
      })

      // Apply font size
      document.documentElement.style.fontSize = `${settings.fontSize}px`
    } catch {
      // Silent failure
    }
  },

  setSettingsDraft: (patch) =>
    set((state) => ({ settingsDraft: { ...state.settingsDraft, ...patch } })),

  setPermissionRulesDraft: (scope, rules) =>
    set((state) => ({ permissionRulesDrafts: { ...state.permissionRulesDrafts, [scope]: rules } })),

  clearSettingsDraft: () =>
    set({ settingsDraft: {}, permissionRulesDrafts: { global: null, workspace: null } }),

  setPermissionMode: async (mode) => {
    const updated = await window.piDesktop.settings.save({ permissionMode: mode })
    set({ settings: updated })
    if (get().piStatus === 'running') {
      await get().restartPi()
    }
  },

  saveSidebarWidth: async (width) => {
    // Called once when a drag ends, never per mousemove — the live width is local
    // to the sidebar so dragging does not write settings.json on every pixel.
    const updated = await window.piDesktop.settings.save({
      sidebarWidth: clampSidebarWidth(width),
    })
    set({ settings: updated })
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
      case 'message_start': {
        // User messages can enter the session without passing through this
        // GUI — pi-nvim and other socket/extension bridges inject prompts
        // directly inside the Pi process. Render those here, or the thread
        // shows only the assistant's replies. Our own prompts arrive on this
        // event too, but sendPrompt already rendered them at send time, so a
        // matching pending echo means skip. Assistant-role message_start is
        // ignored: assistant content renders via message_update / message_end.
        const startedMessage = (event as PiMessageStartEvent).message
        if (startedMessage && (startedMessage as { role?: unknown }).role === 'user') {
          const parsed = parseAgentMessage(startedMessage)
          if (parsed && parsed.content.trim() && !consumeLocalEcho(parsed.content)) {
            get().addMessage(parsed)
            // Mirror sendPrompt's turn-start state so the external turn gets
            // a live streaming bubble instead of content appearing only at
            // message_end. agent_end clears isStreaming as usual. When a turn
            // is already streaming (an external steer injected mid-turn), the
            // in-progress content and tool-call state must survive.
            if (!get().isStreaming) {
              set({
                isStreaming: true,
                streamingContent: '',
                streamingThinking: '',
                streamingToolCalls: new Map(),
              })
            }
            get().addTimelineEvent({
              id: generateId(),
              type: 'system',
              timestamp: Date.now(),
              title: 'External prompt received',
              status: 'success',
            })
          }
        }
        break
      }

      case 'message_update':
        handleMessageUpdate(event as PiMessageUpdateEvent, set)
        break

      case 'message_end': {
        const endedMessage = (event as { message?: Record<string, unknown> }).message
        handleTurnComplete(set, endedMessage)
        // turn_end re-delivers the same message, so errors surface only here.
        const turnError = turnErrorText(endedMessage)
        if (turnError) {
          get().addMessage({
            id: generateId(),
            role: 'system',
            content: `Error: ${turnError}`,
            timestamp: Date.now(),
          })
        }
        get().addTimelineEvent({
          id: generateId(),
          type: 'assistant_message',
          timestamp: Date.now(),
          title: turnError ? 'Assistant response failed' : 'Assistant response complete',
          status: turnError ? 'error' : 'success',
        })
        // Attached mid-turn: the commit above only held the post-attach
        // suffix of this message — replace it with the persisted full one.
        // The reload's teardown (idleTurnState inside clearMessages) disarms
        // the attach and the indicator, so re-arm afterwards from the
        // authoritative signal: the activity map still reporting the turn
        // live. If the turn ended during the backfill the map says idle (or
        // its broadcast is about to and the reconciliation settles it).
        if (get().reattachedMidTurn) {
          void enqueueAttachBackfill(get).then(() => {
            const after = get()
            const activeId = after.activeWorkspace?.id
            const activity = activeId ? after.workspaceActivity[activeId]?.state : undefined
            if (
              (activity === 'working' || activity === 'needs-approval') &&
              !after.sessionLoading
            ) {
              set({ isStreaming: true, reattachedMidTurn: true })
            }
          })
        }
        break
      }

      case 'turn_end':
        handleTurnComplete(set, (event as { message?: Record<string, unknown> }).message)
        break

      case 'agent_start':
        // A fresh turn means real stream context from its first byte — any
        // pending mid-turn-attach backfill was already handled at agent_end.
        set({ reattachedMidTurn: false })
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
        // Attached mid-turn and the turn just ended: the stream buffers never
        // held the full response, so pull the finished messages from the
        // session instead of leaving the pre-attach view on screen.
        if (get().reattachedMidTurn) {
          set({ reattachedMidTurn: false })
          void enqueueAttachBackfill(get)
        }
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

      case 'extension_ui_request': {
        const uiEvent = event as PiExtensionUiRequest
        if (uiEvent.method === 'setWidget') {
          // Fire-and-forget: no renderer surface consumes widget lines yet.
        } else if (uiEvent.method === 'setStatus') {
          set((state) => {
            const key = uiEvent.statusKey ?? 'default'
            if (uiEvent.statusText === undefined) {
              const { [key]: _removed, ...rest } = state.extensionStatuses
              return { extensionStatuses: rest }
            }
            return {
              extensionStatuses: {
                ...state.extensionStatuses,
                [key]: uiEvent.statusText,
              },
            }
          })
        } else if (uiEvent.method === 'setTitle' || uiEvent.method === 'set_editor_text') {
          // Fire-and-forget: nothing to store in state.
        } else if (uiEvent.method === 'notify') {
          // Toast slot: kept apart from the dialog slot so a notification can
          // never clobber an unanswered blocking prompt.
          set({ extensionNotify: uiEvent })
        } else {
          // Blocking dialog methods (select, confirm, input, editor).
          set({ extensionUiRequest: uiEvent })
        }
        break
      }

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

  dismissExtensionNotify: () => {
    const { extensionNotify } = get()
    if (!extensionNotify) return
    // Pi ignores responses to unknown ids, so answering a fire-and-forget
    // notify is harmless — and it must never touch the dialog slot.
    window.piDesktop.ui.respondInput(extensionNotify.id, '')
    set({ extensionNotify: null })
  },

  handlePendingPromptCounts: (counts) => set({ pendingPromptCounts: counts }),

  handleWorkspaceActivity: (map) => {
    const state = get()
    const activeId = state.activeWorkspace?.id
    const activity = activeId ? map[activeId]?.state : undefined
    const working = activity === 'working' || activity === 'needs-approval'
    // Disarm: the turn can end during a switch itself, while this workspace's
    // manager was not yet the active one — its agent_end is filtered and
    // never reaches the renderer. The activity map always arrives, so a
    // working state that disappears while the attach flag is up means the
    // turn is over: stop the indicator and backfill.
    if (state.reattachedMidTurn && !working) {
      set({ workspaceActivity: map, reattachedMidTurn: false, isStreaming: false })
      void enqueueAttachBackfill(get)
      return
    }
    // Arm: a live turn in the active workspace with no live view — e.g. a
    // renderer reload (Ctrl+R) mid-turn boots with idle state and would
    // otherwise stream invisibly and commit a truncated message. The
    // sessionLoading guard keeps this out of session-change teardown windows.
    if (!state.reattachedMidTurn && working && !state.isStreaming && !state.sessionLoading) {
      set({ workspaceActivity: map, isStreaming: true, reattachedMidTurn: true })
      return
    }
    set({ workspaceActivity: map })
  },

  handleSessionRuntime: (runtime) => {
    const state = get()
    set((current) => ({
      sessionRuntimes: { ...current.sessionRuntimes, [runtime.runtimeId]: runtime },
      activeSessionRuntimeId: runtime.active
        ? runtime.runtimeId
        : current.activeSessionRuntimeId === runtime.runtimeId
          ? null
          : current.activeSessionRuntimeId,
      ...(runtime.active ? {
        piStatus: runtime.status,
        piPid: runtime.pid,
        piError: runtime.error,
      } : {}),
    }))
    if (
      runtime.active &&
      runtime.status === 'running' &&
      runtime.sessionPath &&
      state.sessionState?.sessionFile !== runtime.sessionPath &&
      !state.sessionLoading
    ) {
      void get().reloadActiveSession({ refreshList: false })
    }
  },

  recoverPendingPrompts: async () => {
    // Isolated: the activity snapshot is cosmetic and must never block the
    // prompt flush below, which recovers a held blocking dialog.
    try {
      get().handleWorkspaceActivity(await window.piDesktop.workspace.getActivity())
    } catch {
      // Non-fatal: the next activity broadcast catches the renderer up.
    }
    try {
      get().handlePendingPromptCounts(await window.piDesktop.ui.getPendingPrompts())
      const workspace = await window.piDesktop.workspace.getActive()
      if (workspace) await window.piDesktop.ui.flushPendingPrompts(workspace.id)
    } catch {
      // Non-fatal: the next counts broadcast or flush catches the renderer up.
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

  maybeWarnWorkspacePermissionRules: async () => {
    try {
      const status = await window.piDesktop.permissionRules.workspaceStatus()
      if (!status.hasWorkspaceRules || status.acknowledged || !status.workspacePath) return

      if (status.hasAllowRules && !status.trusted) {
        // The repo defines allow rules that would let Pi skip permission prompts.
        // They stay inert until the user explicitly trusts this workspace.
        const trust = await get().requestConfirm({
          title: 'Trust this workspace?',
          message:
            'This workspace defines permission rules (.pi-desktop/permission-rules.json) with allow ' +
            'rules that would let Pi skip confirmation prompts. They are ignored until you trust this ' +
            'workspace; its deny rules always apply. Only trust workspaces from a source you trust.',
          confirmLabel: 'Trust workspace',
          cancelLabel: 'Keep untrusted',
        })
        if (trust) {
          await window.piDesktop.permissionRules.setWorkspaceTrust(true)
        }
      } else {
        await get().requestConfirm({
          title: 'Workspace permission rules',
          message:
            'This workspace defines its own permission rules (.pi-desktop/permission-rules.json). ' +
            'Its deny rules restrict Pi while you work here; your global rules apply otherwise.',
          confirmLabel: 'OK',
          cancelLabel: 'Dismiss',
        })
      }

      // Acknowledge so the prompt does not fire on every Pi start. Fetch fresh
      // settings rather than trusting the possibly-stale store snapshot, so a
      // concurrent settings save elsewhere can't be clobbered by an ack list
      // built from data that predates it.
      const current = await window.piDesktop.settings.getAll()
      const acked = current.permissionRulesAckWorkspaces ?? []
      if (!acked.includes(status.workspacePath)) {
        const updated = await window.piDesktop.settings.save({
          permissionRulesAckWorkspaces: [...acked, status.workspacePath],
        })
        set({ settings: updated })
      }
    } catch {
      // Non-fatal: the warning tries again on the next Pi start.
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
    // Main activates an existing workspace on a duplicate path — inside the
    // create call, with none of the switch teardown. Route the duplicate
    // through switchWorkspace instead, so every caller gets the dirty-editor
    // ask, the chat clear, and the status resync; the already-active duplicate
    // needs nothing at all.
    const duplicate = get().workspaces.find((w) => pathsEqual(w.path, path))
    if (duplicate) {
      if (duplicate.id !== get().activeWorkspace?.id) {
        await get().activateWorkspace(duplicate.id)
      }
      return
    }
    const previousActiveId = get().activeWorkspace?.id ?? null
    try {
      await window.piDesktop.workspace.create(name, path)
      await get().loadWorkspaces()
      adoptMainSideActivation(get, set, previousActiveId)
    } catch (err) {
      get().addMessage({
        id: generateId(),
        role: 'system',
        content: `Create workspace error: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now(),
      })
    }
  },

  createWorktreeTab: async () => {
    if (!(await get().confirmDiscardEditorChanges())) return
    try {
      // A new tab starts from the repository's HEAD, never by copying the
      // source tab's dirty files. That makes opening a tab safe while the old
      // Pi is actively editing its own checkout.
      const workspace = await window.piDesktop.workspace.createTab()
      await get().loadWorkspaces()
      const switched = await get().activateWorkspace(workspace.id)
      if (switched) {
        get().setCurrentView('chat')
        if (workspace.sourceWasDirty) {
          get().addMessage({
            id: generateId(),
            role: 'system',
            content: 'This tab starts from the last commit. Uncommitted files remain in the source tab.',
            timestamp: Date.now(),
          })
        }
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      const content = /not a git repository/i.test(detail)
        ? 'This project is not a Git repository. Use New session for another conversation, or open a Git project for an isolated tab.'
        : `New isolated tab error: ${detail}`
      get().addMessage({
        id: generateId(),
        role: 'system',
        content,
        timestamp: Date.now(),
      })
    }
  },

  openFolderAsWorkspace: async (folderPath) => {
    // No trim: leading/trailing spaces are legal in POSIX folder names, and the
    // path arrives verbatim from the OS (drop or dialog), never from typing.
    if (!folderPath) return false
    try {
      const kind = await window.piDesktop.system.pathKind(folderPath)
      if (!kind.exists || !kind.isDirectory) {
        get().addMessage({
          id: generateId(),
          role: 'system',
          content: `Cannot open as project — not a folder: ${folderPath}`,
          timestamp: Date.now(),
        })
        get().setCurrentView('chat')
        return false
      }
      // Re-drop / re-open of the current project: nothing to switch, just make
      // sure the chat is on screen and Pi is up.
      const active = get().activeWorkspace
      if (active && pathsEqual(active.path, folderPath)) {
        get().setCurrentView('chat')
        if (get().piStatus !== 'running') await get().startPi()
        return true
      }
      // An already-registered folder must NOT go through createWorkspace:
      // main's create activates a duplicate path immediately, before
      // switchWorkspace can raise the still-working confirm — declining it
      // would then leave main and the chat pane on different workspaces.
      // Only a genuinely new path gets created (main leaves the active
      // workspace alone then, except for the very first workspace, where
      // there is no prior state for the confirm to protect).
      let ws = get().workspaces.find((w) => pathsEqual(w.path, folderPath))
      if (!ws) {
        await get().createWorkspace(workspaceNameFromFolderPath(folderPath), folderPath)
        ws = get().workspaces.find((w) => pathsEqual(w.path, folderPath))
        if (!ws) return false
      }
      const switched = await get().activateWorkspace(ws.id)
      if (switched) get().setCurrentView('chat')
      return switched
    } catch (err) {
      get().addMessage({
        id: generateId(),
        role: 'system',
        content: `Open folder error: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now(),
      })
      return false
    }
  },

  // Fast workspace activation commits the project pointer immediately. Pi
  // startup and session hydration continue in the background.
  activateWorkspace: async (workspaceId, options) => {
    if (get().activeWorkspace?.id === workspaceId) {
      if (options?.start !== false && get().piStatus !== 'running') void get().startPi()
      return true
    }
    if (!(await get().confirmDiscardEditorChanges())) return false
    try {
      const workspace = await window.piDesktop.workspace.setActive(workspaceId)
      sessionLoadGeneration += 1
      get().clearMessages()
      set((state) => ({
        workspaces: state.workspaces.some((item) => item.id === workspace.id)
          ? state.workspaces.map((item) => item.id === workspace.id ? workspace : item)
          : [...state.workspaces, workspace],
        activeWorkspace: workspace,
        sessionState: null,
        sessionStats: null,
        sessionLoading: true,
        piStatus: 'starting',
        piPid: null,
        piError: null,
        extensionUiRequest: null,
        previewTarget: null,
        editorDirty: false,
      }))
      void window.piDesktop.ui.flushPendingPrompts(workspace.id)
      if (options?.start !== false) void get().startPi()
      return true
    } catch (err) {
      get().addMessage({
        id: generateId(),
        role: 'system',
        content: `Switch workspace error: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now(),
      })
      return false
    }
  },

  switchWorkspace: async (workspaceId, options) => {
    const skipSessionLoad = options?.skipSessionLoad === true
    // Whether setActive committed on the main side. Gates the finally-flush:
    // flushing on a declined gate or a failed setActive would target a
    // workspace the user never actually switched to.
    let switchCommitted = false
    try {
      // Workspace switches are safe: the old workspace's Pi process keeps
      // running and the activity tracker continues to observe it. Only the
      // editor buffer needs a confirmation because it cannot follow the path.
      // The editor buffer belongs to the workspace being left, and the new
      // workspace's file service refuses paths outside its root — unsaved
      // edits would be stranded unsaveable. Ask before committing the switch.
      if (!(await get().confirmDiscardEditorChanges())) return false
      await window.piDesktop.workspace.setActive(workspaceId)
      switchCommitted = true
      // The dialog on screen belongs to the workspace being left. Clear it
      // WITHOUT answering: main retains the request and re-broadcasts it on
      // switch-back, while a synthesized deny would hard-block the asking
      // tool. Must happen only after setActive succeeds — on a failed switch
      // the dialog still belongs on screen. The preview closes for the same
      // reason: its file lives in the old workspace.
      set({ extensionUiRequest: null, previewTarget: null, editorDirty: false })
      // The switch has committed on the main side as of this point — an
      // unsaved workspace-rules draft belongs to the workspace being left, so
      // discard it now rather than at the end of this chain. Doing it here
      // (before any of the awaits below, and before loadWorkspaces() updates
      // `activeWorkspace`) means it can't be skipped by a later throw in this
      // chain, and the settings panel's own activeWorkspace-change effect can
      // never observe a stale draft under the new workspace.
      get().setPermissionRulesDraft('workspace', null)
      get().clearMessages()
      // Re-sync Pi status from main: each workspace has its own PiRpcManager,
      // so the new active workspace's Pi may be in a different state than
      // what piStatus is currently showing. Without this, the `if running return`
      // guard in startPi() would skip starting the new active workspace's Pi.
      const status = await window.piDesktop.pi.getStatus()
      set({ piStatus: status.status, piPid: status.pid, piError: status.error })
      await get().loadWorkspaces()
      // Session list + Pi start; skip full history when a follow-up switchSession
      // will load the target session (sidebar/session panel open flow).
      scheduleSessionListRefresh(get)
      await get().startPi()
      if (!skipSessionLoad && get().piStatus === 'running') {
        sessionLoadGeneration += 1
        await get().reloadActiveSession({ refreshList: false })
        // A turn may already be running here (that is what the sidebar dot
        // advertised). The reload above only shows persisted messages, so
        // without this the chat looks idle while Pi is mid-response. Show the
        // working indicator and mark the attach so the next turn boundary
        // backfills from the session (the stream buffers missed the prefix).
        const activity = get().workspaceActivity[workspaceId]?.state
        if (activity === 'working' || activity === 'needs-approval') {
          set({ isStreaming: true, reattachedMidTurn: true })
        }
      } else if (get().piStatus === 'running') {
        // Stats only. Refreshing sessionState here races the follow-up
        // switchSession this flow contracts for: when the refresh lands
        // first, the fast path sees its target "already active" over the
        // chat this switch just cleared — an empty screen and a dead click.
        // That switchSession's reload refreshes state and stats anyway.
        void get().refreshSessionStats()
      }
      await get().maybeWarnWorkspacePermissionRules()
      return true
    } catch (err) {
      get().addMessage({
        id: generateId(),
        role: 'system',
        content: `Switch workspace error: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now(),
      })
      return false
    } finally {
      // Replay any blocking prompt main holds for the new workspace. In
      // `finally` because every post-commit await above can reject and the
      // held prompt must still surface; main no-ops the flush unless the
      // workspace is active when it executes.
      if (switchCommitted) {
        void window.piDesktop.ui.flushPendingPrompts(workspaceId)
      }
    }
  },

  removeWorkspace: async (workspaceId) => {
    const workspace = get().workspaces.find((w) => w.id === workspaceId)
    const isWorktree = workspace?.kind === 'worktree'
    const confirmed = await get().requestConfirm({
      title: isWorktree ? 'Close tab' : 'Remove workspace',
      message: isWorktree
        ? `Close "${workspace?.name ?? workspaceId}"? Clean worktrees are removed; tabs with uncommitted changes are preserved on disk.`
        : `Remove "${workspace?.name ?? workspaceId}" from the sidebar? Its Pi process stops; files on disk are not touched.`,
      confirmLabel: isWorktree ? 'Close tab' : 'Remove',
      cancelLabel: 'Cancel',
      danger: true,
    })
    if (!confirmed) return
    // Removing the active workspace closes its preview via the adoption
    // below — a dirty editor gets the same ask a workspace switch gives it.
    if (workspaceId === get().activeWorkspace?.id) {
      if (!(await get().confirmDiscardEditorChanges())) return
    }
    const previousActiveId = get().activeWorkspace?.id ?? null
    try {
      const result = await window.piDesktop.workspace.remove(workspaceId)
      await get().loadWorkspaces()
      adoptMainSideActivation(get, set, previousActiveId)
      if (result.preservedWorktreePath) {
        get().addMessage({
          id: generateId(),
          role: 'system',
          content: `Tab closed, but its uncommitted worktree was preserved at ${result.preservedWorktreePath}`,
          timestamp: Date.now(),
        })
      }
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
    // Repointing the active workspace restarts its Pi below (the working
    // directory is bound at spawn — without a restart Pi keeps operating in
    // the old folder while the UI shows the new one) and strands the open
    // preview (the file service refuses paths outside the new root). Ask
    // about the in-flight turn and the editor buffer before touching anything.
    const isActive = workspaceId === get().activeWorkspace?.id
    if (isActive && !(await get().confirmSessionChange('changeFolder'))) return
    if (isActive && !(await get().confirmDiscardEditorChanges())) return
    const restartNeeded = isActive && get().piStatus === 'running'
    try {
      await window.piDesktop.workspace.changePath(workspaceId, newPath)
      await get().loadWorkspaces()
      if (isActive) set({ previewTarget: null, editorDirty: false })
      // Main stopped this workspace's Pi with the repoint; bring the active
      // one back up in the new folder.
      if (restartNeeded) await get().restartPi()
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

  // Load the full catalog once; the Catalog tab filters it locally on each
  // keystroke (no per-keystroke IPC). catalogLoading gates only this one-time load.
  loadCatalog: async () => {
    set({ catalogLoading: true })
    try {
      const packages = await window.piDesktop.packages.fetchCatalog()
      set({ catalogPackages: packages })
    } catch {
      // Silent failure
    } finally {
      set({ catalogLoading: false })
    }
  },

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

  setPreviewTarget: async (target) => {
    const current = get().previewTarget
    // Same code file re-selected: FilePreview's load effect keys on `path`, so
    // it won't re-run and the edit buffer survives — nothing to confirm, and
    // the dirty flag must stand.
    const sameCodeFile =
      target?.kind === 'code' && current?.kind === 'code' && target.path === current.path
    if (sameCodeFile) {
      set({ previewTarget: target })
      return true
    }
    if (!(await get().confirmDiscardEditorChanges())) return false
    // The dirty flag falls with the buffer it described: the component reloads
    // (or unmounts) from the new target and re-syncs from a clean slate.
    set({ previewTarget: target, editorDirty: false })
    return true
  },

  setEditorDirty: (dirty) => {
    if (get().editorDirty !== dirty) set({ editorDirty: dirty })
  },

  confirmDiscardEditorChanges: async () => {
    if (!get().editorDirty) return true
    const name = get().previewTarget?.name
    return get().requestConfirm({
      title: 'Unsaved changes',
      message: name ? `Discard unsaved changes to ${name}?` : 'Discard unsaved changes?',
      confirmLabel: 'Discard changes',
      cancelLabel: 'Keep editing',
      danger: true,
    })
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
    set((state) => ({
      // Stay on Home if the user is there; otherwise jump to chat (notes/palette).
      currentView: state.currentView === 'home' ? 'home' : 'chat',
      notePickerOpen: false,
      pendingInsert: { text, nonce: Date.now(), replace },
    })),

  clearPendingInsert: () => set({ pendingInsert: null }),

  setNotePickerOpen: (open) => set({ notePickerOpen: open }),

  setCommandPalette: (open) => set({ commandPaletteOpen: open }),
  setTaskLauncherOpen: (open) => set({ taskLauncherOpen: open }),

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

// Mirror editor-dirty transitions to main, which guards quit, window close,
// and reload behind a discard confirmation — teardown outruns any
// renderer-side ask, so the decision must be local to main. A subscription
// (rather than a call inside setEditorDirty) catches every write path:
// several actions clear the flag with a direct set() alongside other keys,
// and a stale main-side cache would make quit nag after an in-app discard.
useAppStore.subscribe((state, prev) => {
  if (state.editorDirty === prev.editorDirty) return
  window.piDesktop.ui.setEditorDirty(
    state.editorDirty,
    state.editorDirty ? (state.previewTarget?.name ?? null) : null
  )
})

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

// Pi reports a generic abort with exactly this text; anything else on an
// aborted turn is a specific reason worth showing (mirrors Pi's own TUI).
const GENERIC_ABORT_MESSAGE = 'Request was aborted'
const UNKNOWN_TURN_ERROR = 'Unknown error'

/**
 * Error text to surface in chat for a finished assistant message, or null.
 * A provider that rejects before streaming (e.g. HTTP 402) yields an
 * assistant message with stopReason 'error', empty content, and the provider
 * error in errorMessage — without this, the chat shows nothing at all.
 */
function turnErrorText(message?: Record<string, unknown>): string | null {
  if (!message || message.role !== 'assistant') return null
  const errorMessage = typeof message.errorMessage === 'string' ? message.errorMessage : ''
  if (message.stopReason === 'error') return errorMessage || UNKNOWN_TURN_ERROR
  if (message.stopReason === 'aborted' && errorMessage && errorMessage !== GENERIC_ABORT_MESSAGE) {
    return errorMessage
  }
  return null
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
        result: tc.result,
        isError: tc.isError,
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

      for (const [id, tc] of entries) {
        if (!tc.result) continue
        newMessages.push({
          id: `${id}-result`,
          role: 'toolResult',
          content: tc.result,
          timestamp: Date.now(),
          toolCallId: id,
          toolName: tc.name,
        })
      }
    }

    return {
      messages: newMessages,
      streamingContent: '',
      streamingThinking: '',
      streamingToolCalls: new Map(),
      subagentProgress: [],
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
    // Track subagent calls in subagentProgress
    if (event.toolName === 'subagent' || event.toolName === 'subagent_wait') {
      const args = event.args as Record<string, unknown>
      const agent = typeof args.agent === 'string' ? args.agent : 'subagent'
      const task = typeof args.task === 'string' ? args.task : ''
      const newProgress = {
        toolCallId: event.toolCallId,
        agent,
        status: 'running',
        task: task.slice(0, 120),
        toolCount: 0,
        tokens: 0,
        durationMs: 0,
      }
      return {
        streamingToolCalls: newMap,
        subagentProgress: [...state.subagentProgress, newProgress],
      }
    }
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
        result: text || existing.result,
      })
    }

    // Update subagent progress from details
    if (event.toolName === 'subagent' || event.toolName === 'subagent_wait') {
      const details = event.partialResult.details as Record<string, unknown> | undefined
      const progressList = details?.progress as Array<Record<string, unknown>> | undefined
      const results = details?.results as Array<Record<string, unknown>> | undefined
      if (progressList || results) {
        const newProgress = state.subagentProgress.map((p) => {
          if (p.toolCallId !== event.toolCallId) return p
          return {
            ...p,
            ...aggregateSubagentDetails(p, progressList, results),
          }
        })
        return { streamingToolCalls: newMap, subagentProgress: newProgress }
      }
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
        isError: event.isError,
        result: resultText || existing.result,
        durationMs: existing.startedAt ? Date.now() - existing.startedAt : existing.durationMs,
      })
    }

    // Finalize subagent progress: mark done and capture final stats
    const newProgress = state.subagentProgress.map((p) => {
      if (p.toolCallId !== event.toolCallId) return p
      const details = (event.toolName === 'subagent' || event.toolName === 'subagent_wait')
        ? (event.result.details as Record<string, unknown> | undefined)
        : undefined
      const progressList = details?.progress as Array<Record<string, unknown>> | undefined
      const results = details?.results as Array<Record<string, unknown>> | undefined
      const agg = aggregateSubagentDetails(p, progressList, results)
      const elapsed =
        agg.durationMs ||
        (p.durationMs > 0 ? p.durationMs : existing?.startedAt ? Date.now() - existing.startedAt : 0)

      return {
        ...p,
        ...agg,
        status: event.isError ? 'error' : 'done',
        durationMs: elapsed,
        currentTool: undefined,
      }
    })

    return { streamingToolCalls: newMap, subagentProgress: newProgress }
  })
}

/** Fold tool details.progress / results into a single progress row (+ children). */
function aggregateSubagentDetails(
  prev: AppState['subagentProgress'][number],
  progressList: Array<Record<string, unknown>> | undefined,
  results: Array<Record<string, unknown>> | undefined
): Partial<AppState['subagentProgress'][number]> {
  let toolCount = 0
  let tokens = 0
  let durationMs = 0
  let currentTool: string | undefined
  const statuses: string[] = []
  const children: NonNullable<AppState['subagentProgress'][number]['children']> = []

  if (progressList) {
    progressList.forEach((prog, index) => {
      const tc = typeof prog.toolCount === 'number' ? prog.toolCount : 0
      const tok = typeof prog.tokens === 'number' ? prog.tokens : 0
      const dur = typeof prog.durationMs === 'number' ? prog.durationMs : 0
      toolCount += tc
      tokens += tok
      durationMs = Math.max(durationMs, dur)
      if (typeof prog.status === 'string') statuses.push(prog.status)
      const tool =
        typeof prog.currentTool === 'string'
          ? prog.currentTool
          : typeof prog.tool === 'string'
            ? prog.tool
            : undefined
      if (tool) currentTool = tool

      const agent =
        typeof prog.agent === 'string'
          ? prog.agent
          : typeof prog.name === 'string'
            ? prog.name
            : prev.agent
      const task =
        typeof prog.task === 'string'
          ? prog.task
          : typeof prog.label === 'string'
            ? prog.label
            : ''
      const st = typeof prog.status === 'string' ? prog.status : 'running'
      const id =
        typeof prog.id === 'string'
          ? prog.id
          : typeof prog.runId === 'string'
            ? prog.runId
            : `${prev.toolCallId}-${index}`

      children.push({
        id,
        agent,
        status: st === 'completed' || st === 'done' ? 'done' : st === 'failed' || st === 'error' ? 'error' : 'running',
        task: task.slice(0, 160),
        toolCount: tc,
        tokens: tok,
        durationMs: dur,
        currentTool: tool,
      })
    })
  }

  if (results) {
    for (const r of results) {
      const usage = r.usage as Record<string, number> | undefined
      if (usage) {
        tokens += (usage.input ?? 0) + (usage.output ?? 0)
      }
    }
  }

  const running = statuses.some((s) => s === 'running' || s === 'starting')
  const allDone =
    statuses.length > 0 &&
    statuses.every((s) => s === 'completed' || s === 'failed' || s === 'done' || s === 'error' || s === 'stopped')

  return {
    status: allDone ? 'done' : running ? 'running' : prev.status,
    toolCount: toolCount || prev.toolCount,
    tokens: tokens || prev.tokens,
    durationMs: durationMs || prev.durationMs,
    currentTool,
    children: children.length > 0 ? children : prev.children,
  }
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
