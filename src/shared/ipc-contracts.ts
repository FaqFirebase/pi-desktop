/**
 * IPC channel constants and typed contracts for secure main↔renderer communication.
 *
 * Every channel has a strictly typed request/response shape.
 * The preload bridge validates payloads against these contracts.
 */

// ─── IPC Channel Names ──────────────────────────────────────────────────────

export const IPC_CHANNELS = {
  // PI process lifecycle
  PI_START: 'pi:start',
  PI_STOP: 'pi:stop',
  PI_RESTART: 'pi:restart',
  PI_STATUS: 'pi:status',

  // PI commands
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

  // Workspaces
  WORKSPACE_LIST: 'workspace:list',
  WORKSPACE_CREATE: 'workspace:create',
  WORKSPACE_REMOVE: 'workspace:remove',
  WORKSPACE_RENAME: 'workspace:rename',
  WORKSPACE_SET_ACTIVE: 'workspace:set-active',
  WORKSPACE_GET_ACTIVE: 'workspace:get-active',
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

  // File operations
  FILE_TREE: 'file:tree',
  FILE_SEARCH: 'file:search',
  FILE_SEARCH_CONTENT: 'file:search-content',
  FILE_READ: 'file:read',
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

  // Events (main → renderer)
  EVENT_PI: 'event:pi',
  EVENT_TERMINAL_DATA: 'event:terminal-data',
  EVENT_TERMINAL_EXIT: 'event:terminal-exit',
} as const

// ─── PI Process Types ───────────────────────────────────────────────────────

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
  args?: string[]
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

// ─── PI RPC Event Types (subset used by renderer) ───────────────────────────

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

export interface SessionDeleteResult {
  ok: boolean
  method: 'trash' | 'unlink'
  error?: string
}

export type ArchivedSessionsMap = Record<string, number>

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
  theme: 'dark' | 'light' | 'system' | 'nord' | 'gruvbox'
  defaultModel: string | null
  defaultProvider: string | null
  defaultCwd: string | null
  fontSize: number
  showThinking: boolean
  autoScroll: boolean
  permissionMode: PermissionMode
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
