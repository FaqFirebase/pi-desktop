/**
 * IPC channel constants and typed contracts for secure main↔renderer communication.
 *
 * Every channel has a strictly typed request/response shape.
 * The preload bridge validates payloads against these contracts.
 */

// ─── IPC Channel Names ──────────────────────────────────────────────────────

export const IPC_CHANNELS = {
  // Pi process lifecycle
  PI_START: 'pi:start',
  PI_STOP: 'pi:stop',
  PI_RESTART: 'pi:restart',
  PI_STATUS: 'pi:status',

  // Pi commands
  PI_PROMPT: 'pi:prompt',
  PI_STEER: 'pi:steer',
  PI_FOLLOW_UP: 'pi:follow-up',
  PI_ABORT: 'pi:abort',
  PI_BASH: 'pi:bash',
  PI_ABORT_BASH: 'pi:abort-bash',

  // Session management
  SESSION_NEW: 'session:new',
  SESSION_SWITCH: 'session:switch',
  SESSION_FORK: 'session:fork',
  SESSION_CLONE: 'session:clone',
  SESSION_LIST: 'session:list',
  SESSION_LIST_ALL: 'session:list-all',
  SESSION_GET_STATE: 'session:get-state',
  SESSION_GET_MESSAGES: 'session:get-messages',
  SESSION_GET_STATS: 'session:get-stats',
  SESSION_SET_NAME: 'session:set-name',
  SESSION_EXPORT_HTML: 'session:export-html',
  SESSION_GET_FORK_MESSAGES: 'session:get-fork-messages',
  SESSION_DELETE: 'session:delete',
  SESSION_ARCHIVE: 'session:archive',
  SESSION_UNARCHIVE: 'session:unarchive',
  SESSION_LIST_ARCHIVED: 'session:list-archived',
  SESSION_GET_LINEAGE: 'session:get-lineage',
  SESSION_COMPACT: 'session:compact',

  // Model management
  MODEL_SET: 'model:set',
  MODEL_CYCLE: 'model:cycle',
  MODEL_LIST_AVAILABLE: 'model:list-available',
  THINKING_SET_LEVEL: 'thinking:set-level',
  THINKING_CYCLE_LEVEL: 'thinking:cycle-level',

  // Settings
  SETTINGS_GET_ALL: 'settings:get-all',
  SETTINGS_SAVE: 'settings:save',
  SETTINGS_GET_THEME: 'settings:get-theme',

  // UI
  UI_SELECT_RESPONSE: 'ui:select-response',
  UI_CONFIRM_RESPONSE: 'ui:confirm-response',
  UI_INPUT_RESPONSE: 'ui:input-response',
  UI_EDITOR_RESPONSE: 'ui:editor-response',

  // System
  SYSTEM_OPEN_DIALOG: 'system:open-dialog',
  SYSTEM_GET_PATH: 'system:get-path',
  SYSTEM_OPEN_EXTERNAL: 'system:open-external',
  SYSTEM_GET_VERSION: 'system:get-version',
  UPDATE_CHECK: 'update:check',

  // Workspaces
  WORKSPACE_LIST: 'workspace:list',
  WORKSPACE_CREATE: 'workspace:create',
  WORKSPACE_REMOVE: 'workspace:remove',
  WORKSPACE_RENAME: 'workspace:rename',
  WORKSPACE_SET_ACTIVE: 'workspace:set-active',
  WORKSPACE_GET_ACTIVE: 'workspace:get-active',
  WORKSPACE_CHANGE_PATH: 'workspace:change-path',
  WORKSPACE_PATH_EXISTS: 'workspace:path-exists',
  WORKSPACE_START_PI: 'workspace:start-pi',
  WORKSPACE_STOP_PI: 'workspace:stop-pi',

  // Packages
  PACKAGE_LIST_INSTALLED: 'package:list-installed',
  PACKAGE_INSTALL: 'package:install',
  PACKAGE_REMOVE: 'package:remove',
  PACKAGE_UPDATE: 'package:update',
  PACKAGE_CATALOG_FETCH: 'package:catalog-fetch',

  // Skills
  SKILLS_LIST: 'skills:list',
  COMMANDS_LIST: 'commands:list',
  MCP_SERVERS_LIST: 'mcp:servers-list',

  // Models config
  MODELS_READ: 'models:read',
  MODELS_WRITE: 'models:write',

  // Council planning
  COUNCIL_DETECT: 'council:detect',
  COUNCIL_RUN_CONSULTANTS: 'council:run-consultants',

  // File operations
  FILE_TREE: 'file:tree',
  FILE_SEARCH: 'file:search',
  FILE_SEARCH_CONTENT: 'file:search-content',
  FILE_READ: 'file:read',
  FILE_READ_ATTACHMENT: 'file:read-attachment',
  FILE_WRITE: 'file:write',
  FILE_DIFF: 'file:diff',
  FILE_STAGED_DIFF: 'file:staged-diff',
  GIT_STATUS: 'git:status',
  GIT_BRANCH: 'git:branch',

  // Terminal
  TERMINAL_START: 'terminal:start',
  TERMINAL_INPUT: 'terminal:input',
  TERMINAL_RESIZE: 'terminal:resize',
  TERMINAL_STOP: 'terminal:stop',

  // Session tags
  TAG_GET: 'tag:get',
  TAG_SET: 'tag:set',
  TAG_ADD: 'tag:add',
  TAG_REMOVE: 'tag:remove',
  TAG_GET_ALL: 'tag:get-all',
  TAG_GET_ALL_USED: 'tag:get-all-used',
  TAG_AUTO_GET_ALL: 'tag:auto-get-all',
  TAG_AUTO_ENSURE: 'tag:auto-ensure',
  TAG_AUTO_REMOVE: 'tag:auto-remove',

  // Notes (reusable prompts / commands)
  NOTES_LIST: 'notes:list',
  NOTES_CREATE: 'notes:create',
  NOTES_UPDATE: 'notes:update',
  NOTES_REMOVE: 'notes:remove',

  // Events (main → renderer)
  EVENT_PI: 'event:pi',
  EVENT_FILE_CHANGE: 'event:file-change',
  EVENT_TERMINAL_DATA: 'event:terminal-data',
  EVENT_TERMINAL_EXIT: 'event:terminal-exit',
  EVENT_COUNCIL_PROGRESS: 'event:council-progress',
} as const

// ─── Pi Process Types ───────────────────────────────────────────────────────

export type PiProcessStatus = 'stopped' | 'starting' | 'running' | 'error'

export interface PiStatus {
  status: PiProcessStatus
  pid: number | null
  error: string | null
}

export interface PiStartOptions {
  cwd?: string
  model?: string
  provider?: string
  sessionPath?: string
  noSession?: boolean
  // When true (and neither sessionPath nor noSession is set), Pi is launched
  // with --continue so it resumes the most recent session for the cwd instead
  // of creating a fresh one.
  continueSession?: boolean
  args?: string[]
  env?: Record<string, string>
}

// ─── Terminal Types ─────────────────────────────────────────────────────────

export interface TerminalStartOptions {
  cwd?: string
  cols?: number
  rows?: number
}

export interface TerminalStartResult {
  pid: number
  shell: string
  cwd: string
}

export interface TerminalExitEvent {
  exitCode: number
  signal?: number
}

// ─── Pi RPC Event Types (subset used by renderer) ───────────────────────────

export interface PiAgentStartEvent {
  type: 'agent_start'
}

export interface PiAgentEndEvent {
  type: 'agent_end'
  messages: unknown[]
}

export interface PiMessageUpdateEvent {
  type: 'message_update'
  message: Record<string, unknown>
  assistantMessageEvent: {
    type: string
    contentIndex?: number
    delta?: string
    partial?: Record<string, unknown>
    content?: string
    thinking?: string
    toolCall?: Record<string, unknown>
    reason?: string
  }
}

export interface PiToolExecutionStartEvent {
  type: 'tool_execution_start'
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
}

export interface PiToolExecutionUpdateEvent {
  type: 'tool_execution_update'
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  partialResult: {
    content: Array<{ type: string; text?: string }>
    details: Record<string, unknown>
  }
}

export interface PiToolExecutionEndEvent {
  type: 'tool_execution_end'
  toolCallId: string
  toolName: string
  result: {
    content: Array<{ type: string; text?: string }>
    details: Record<string, unknown>
  }
  isError: boolean
}

export interface PiTurnStartEvent {
  type: 'turn_start'
}

export interface PiTurnEndEvent {
  type: 'turn_end'
  message: Record<string, unknown>
  toolResults: unknown[]
}

export interface PiQueueUpdateEvent {
  type: 'queue_update'
  steering: string[]
  followUp: string[]
}

export interface PiCompactionStartEvent {
  type: 'compaction_start'
  reason: string
}

export interface PiCompactionEndEvent {
  type: 'compaction_end'
  reason: string
  result: unknown
  aborted: boolean
  willRetry: boolean
  errorMessage?: string
}

export interface PiAutoRetryStartEvent {
  type: 'auto_retry_start'
  attempt: number
  maxAttempts: number
  delayMs: number
  errorMessage: string
}

export interface PiAutoRetryEndEvent {
  type: 'auto_retry_end'
  success: boolean
  attempt: number
  finalError?: string
}

export interface PiExtensionErrorEvent {
  type: 'extension_error'
  extensionPath: string
  event: string
  error: string
}

export interface PiResponseEvent {
  type: 'response'
  command: string
  id?: string
  success: boolean
  error?: string
  data?: unknown
}

// Extension UI events
export interface PiExtensionUiRequest {
  type: 'extension_ui_request'
  id: string
  method: 'select' | 'confirm' | 'input' | 'editor' | 'notify' | 'setStatus' | 'setWidget' | 'setTitle' | 'set_editor_text'
  title?: string
  message?: string
  options?: string[]
  placeholder?: string
  prefill?: string
  notifyType?: 'info' | 'warning' | 'error'
  statusKey?: string
  statusText?: string
  widgetKey?: string
  widgetLines?: string[]
  widgetPlacement?: string
  timeout?: number
}

export interface PiMessageStartEvent {
  type: 'message_start'
  message: Record<string, unknown>
}

export interface PiMessageEndEvent {
  type: 'message_end'
  message: Record<string, unknown>
}

export interface PiStatusChangeEvent {
  type: 'status_change'
  status: PiProcessStatus
  pid: number | null
  error: string | null
}

export type PiRpcEvent =
  | PiAgentStartEvent
  | PiAgentEndEvent
  | PiMessageStartEvent
  | PiMessageUpdateEvent
  | PiMessageEndEvent
  | PiToolExecutionStartEvent
  | PiToolExecutionUpdateEvent
  | PiToolExecutionEndEvent
  | PiTurnStartEvent
  | PiTurnEndEvent
  | PiQueueUpdateEvent
  | PiCompactionStartEvent
  | PiCompactionEndEvent
  | PiAutoRetryStartEvent
  | PiAutoRetryEndEvent
  | PiExtensionErrorEvent
  | PiResponseEvent
  | PiExtensionUiRequest
  | PiStatusChangeEvent

// ─── Model Types ────────────────────────────────────────────────────────────

export interface ModelInfo {
  id: string
  name: string
  api: string
  provider: string
  baseUrl: string
  reasoning: boolean
  input: string[]
  contextWindow: number
  maxTokens: number
  cost: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
  }
}

// ─── Session Types ──────────────────────────────────────────────────────────

export interface SessionState {
  model: ModelInfo | null
  thinkingLevel: string
  isStreaming: boolean
  isCompacting: boolean
  steeringMode: string
  followUpMode: string
  sessionFile: string | null
  sessionId: string
  sessionName: string | null
  autoCompactionEnabled: boolean
  messageCount: number
  pendingMessageCount: number
}

export interface SessionStats {
  sessionFile: string | null
  sessionId: string
  userMessages: number
  assistantMessages: number
  toolCalls: number
  toolResults: number
  totalMessages: number
  tokens: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
  }
  cost: number
  contextUsage: {
    tokens: number | null
    contextWindow: number
    percent: number | null
  } | null
}

export interface SessionListItem {
  path: string
  name: string | null
  sessionId: string
  lastModified: number
  messageCount: number
  projectPath: string
  projectName: string
}

export interface AutoTagSessionRef {
  sessionId: string
  path: string
}

export interface SessionDeleteResult {
  ok: boolean
  method: 'trash' | 'unlink'
  error?: string
}

export type ArchivedSessionsMap = Record<string, number>

// File extensions Pi accepts as inline images (matches Pi's RPC image support).
export const SUPPORTED_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'] as const

/** A single image attachment in the shape Pi's RPC `prompt` command expects. */
export interface PromptImage {
  type: 'image'
  mimeType: string
  /** Base64-encoded image bytes (no data: URI prefix). */
  data: string
}

/**
 * Result of reading a user-selected attachment. Images are returned as a
 * Pi-ready `PromptImage`; everything else is read as UTF-8 text to inline.
 */
export type AttachmentReadResult =
  | { kind: 'image'; name: string; image: PromptImage }
  | { kind: 'text'; name: string; content: string }

/** Options for the native open dialog. Defaults to picking a directory. */
export interface OpenDialogOptions {
  title?: string
  mode?: 'file' | 'directory'
  filters?: Array<{ name: string; extensions: string[] }>
}

export type { SessionLineageRecord } from './session-lineage'
export type { ModelsConfig, ProviderConfig, CustomModel } from './models-config'
export type {
  CouncilConfig,
  CouncilAgentId,
  ConsensusMode,
  ConsultantResult,
  ConsultantStatus,
} from './council-config'

import type { CouncilAgentId as CouncilAgentIdType, ConsultantResult as ConsultantResultType } from './council-config'

/** Result of COUNCIL_DETECT. */
export interface CouncilDetectResult {
  agents: Array<{ id: CouncilAgentIdType; found: boolean }>
}

/**
 * Request payload for COUNCIL_RUN_CONSULTANTS. The working directory is NOT
 * part of the payload: the main process resolves it from the active workspace,
 * so consultants always run against the real project tree.
 */
export interface CouncilRunRequest {
  request: string
  members: CouncilAgentIdType[]
  timeoutSeconds: number
  consensusMode: 'arbiter' | 'debate'
}

/** Result of COUNCIL_RUN_CONSULTANTS. */
export interface CouncilRunResult {
  results: ConsultantResultType[]
}

/**
 * Streamed live during a council run (main → renderer on EVENT_COUNCIL_PROGRESS).
 * `chunk` is human-readable text appended to the consultant's live output:
 * raw stdout for Codex, parsed text deltas for Claude.
 */
export interface CouncilProgressEvent {
  id: CouncilAgentIdType
  chunk: string
}

import type { ModelsConfig as ModelsConfigType } from './models-config'
import type { CouncilConfig } from './council-config'
/** Result of the MODELS_READ IPC call. */
export type ModelsReadResult = { config: ModelsConfigType } | { error: string; raw: string }

// ─── Agent Message Types ────────────────────────────────────────────────────

export interface AgentTextContent {
  type: 'text'
  text: string
}

export interface AgentThinkingContent {
  type: 'thinking'
  thinking: string
}

export interface AgentToolCallContent {
  type: 'toolCall'
  id: string
  name: string
  arguments: Record<string, unknown>
}

export type AgentContentBlock = AgentTextContent | AgentThinkingContent | AgentToolCallContent

export interface AgentUserMessage {
  role: 'user'
  content: string | AgentContentBlock[]
  timestamp: number
  attachments?: unknown[]
  id?: string
  parentId?: string
}

export interface AgentAssistantMessage {
  role: 'assistant'
  content: AgentContentBlock[]
  api: string
  provider: string
  model: string
  usage: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    cost: {
      input: number
      output: number
      cacheRead: number
      cacheWrite: number
      total: number
    }
  }
  stopReason: string
  timestamp: number
  id?: string
  parentId?: string
}

export interface AgentToolResultMessage {
  role: 'toolResult'
  toolCallId: string
  toolName: string
  content: Array<{ type: string; text?: string }>
  isError: boolean
  timestamp: number
  id?: string
  parentId?: string
}

export type AgentMessage = AgentUserMessage | AgentAssistantMessage | AgentToolResultMessage

// ─── Settings Types ─────────────────────────────────────────────────────────

export type PermissionMode = 'plan-readonly' | 'ask-edits' | 'ask-commands' | 'trusted'

export interface AppSettings {
  piExecutablePath: string
  defaultArgs: string[]
  theme: 'dark' | 'light' | 'system' | 'nord' | 'gruvbox' | 'breeze-dark' | 'breeze-light'
  defaultModel: string | null
  defaultProvider: string | null
  defaultCwd: string | null
  fontSize: number
  showThinking: boolean
  autoScroll: boolean
  permissionMode: PermissionMode
  // Resume the most recent session for the workspace on launch (via Pi's
  // --continue) instead of starting a fresh session.
  resumeLastSession: boolean
  // Project paths whose session group is collapsed in the Sessions panel.
  // Persisted so the collapsed/expanded layout survives navigation and restarts.
  collapsedSessionGroups: string[]
  // Show the Home/launcher screen on launch (Pi starts lazily on first action)
  // instead of booting straight into Chat. When false, legacy behavior applies.
  openToHomeOnLaunch: boolean
  // Multi-agent council planning configuration.
  council: CouncilConfig
}

// ─── Update Check Types ─────────────────────────────────────────────────────

/** Result of checking GitHub releases for a newer version. */
export interface UpdateCheckResult {
  updateAvailable: boolean
  currentVersion: string
  latestVersion: string
  // Release page URL to open for downloading; empty when the check failed.
  url: string
  // Release name/title, when available.
  name?: string
}

// ─── Workspace Types ────────────────────────────────────────────────────────

export interface Workspace {
  id: string
  name: string
  path: string
  createdAt: number
  lastActiveAt: number
  color: string
}

// ─── Notes Types ────────────────────────────────────────────────────────────

/**
 * Scope of a note. Either the literal `'global'` (available everywhere) or a
 * workspace id (only surfaced when that workspace is active). Stored as a
 * single field so all notes live in one store and the UI merges by scope.
 */
export type NoteScope = 'global' | string

/** A reusable prompt or agent command the user has saved. */
export interface Note {
  id: string
  title: string
  body: string
  tags: string[]
  scope: NoteScope
  createdAt: number
  updatedAt: number
}

/** Fields supplied when creating a note. */
export interface NoteInput {
  title: string
  body: string
  tags: string[]
  scope: NoteScope
}

/** Mutable fields when updating a note. */
export type NoteUpdate = Partial<NoteInput>

// ─── Package Types ──────────────────────────────────────────────────────────

export interface InstalledPackage {
  name: string
  source: string
  type: 'extension' | 'skill' | 'prompt' | 'theme' | 'package'
  version: string | null
  path: string
}

export interface CatalogPackage {
  name: string
  description: string
  author: string
  type: string
  downloads: number
  downloadsDisplay: string
  updatedAt: string
  npmUrl: string | null
  repoUrl: string | null
  installCommand: string
}

// ─── Skill Types ────────────────────────────────────────────────────────────

export interface InstalledSkill {
  name: string
  description: string
  path: string
  source: 'global' | 'project' | 'package' | 'cli'
  enabled: boolean
}

// ─── File Types ────────────────────────────────────────────────────────────

export interface FileTreeNode {
  name: string
  path: string
  relativePath: string
  type: 'file' | 'directory'
  children?: FileTreeNode[]
  gitStatus?: GitFileStatus
}

export interface GitFileStatus {
  index: string
  worktree: string
  isStaged: boolean
}

export interface FileSearchResult {
  path: string
  relativePath: string
  name: string
  matchType: 'filename' | 'content'
  line?: number
  snippet?: string
}

/**
 * Emitted (main → renderer, debounced) when files change on disk in the
 * active workspace. The renderer should refresh the file tree and git status
 * wholesale; `changeType`/`relativePath` describe the most recent change in
 * the debounce window and are informational, not an exhaustive change list.
 */
export interface FileChangeEvent {
  changeType: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'
  relativePath: string
}

export interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  content: string
  changes: DiffChange[]
}

export interface DiffChange {
  type: 'add' | 'remove' | 'normal'
  content: string
  oldLine?: number
  newLine?: number
}

export interface DiffFile {
  oldPath: string
  newPath: string
  hunks: DiffHunk[]
  isBinary: boolean
  isNew: boolean
  isDeleted: boolean
}

// ─── Timeline Event Types ───────────────────────────────────────────────────

export interface TimelineEvent {
  id: string
  type: 'user_message' | 'assistant_message' | 'tool_start' | 'tool_end' | 'thinking' | 'compaction' | 'retry' | 'queue' | 'system' | 'error'
  timestamp: number
  duration?: number
  title: string
  detail?: string
  status?: 'running' | 'success' | 'error' | 'cancelled'
  metadata?: Record<string, unknown>
}
