import type { AgentEngineKind } from './ipc-contracts'

/** Apps whose chats can be imported as Pi or OMP sessions. */
export type ChatImportSource = 'claude-code' | 'codex'

export const CHAT_IMPORT_SOURCES: readonly ChatImportSource[] = ['claude-code', 'codex']

/** Product names, so they are never translation keys. */
export const CHAT_IMPORT_SOURCE_LABELS: Record<ChatImportSource, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
}

export function isChatImportSource(value: unknown): value is ChatImportSource {
  return typeof value === 'string' && Object.hasOwn(CHAT_IMPORT_SOURCE_LABELS, value)
}

/**
 * Marker values on every imported assistant message. Never a real provider,
 * so both engines treat the history as another model's and never resend old
 * signed content.
 */
export const IMPORTED_MESSAGE_API = 'pi-desktop-import'
export const IMPORTED_MESSAGE_PROVIDER = 'pi-desktop-import'
/**
 * OMP skips this model value when it restores a session's model, so it never
 * tries to load an unknown one; Pi falls back to the default model.
 */
export const IMPORTED_MESSAGE_MODEL = '<synthetic>'

/** True for a message the chat import wrote: it carries the import provider marker. */
export function isImportedMessage(message: { provider?: unknown }): boolean {
  return message.provider === IMPORTED_MESSAGE_PROVIDER
}

export interface ChatImportListItem {
  sourcePath: string
  sourceSessionId: string
  title: string | null
  cwd: string | null
  cwdExists: boolean
  modifiedAt: number
  sizeBytes: number
  alreadyImported: boolean
}

export interface ChatImportListRequest {
  source: ChatImportSource
  /** The configured engine when left out. */
  engine?: AgentEngineKind
}

export interface ChatImportListing {
  source: ChatImportSource
  engine: AgentEngineKind
  sourceRoot: string
  items: ChatImportListItem[]
}

export interface ChatImportRequest {
  source: ChatImportSource
  engine: AgentEngineKind
  sourcePaths: string[]
}

export interface ChatImportProgress {
  done: number
  total: number
  currentTitle: string | null
}

export type ChatImportFailureCode = 'invalid-path' | 'folder-missing' | 'unreadable' | 'no-messages' | 'write-failed'

export interface ChatImportOutcome {
  sourcePath: string
  title: string | null
}

export interface ChatImportResult {
  imported: Array<ChatImportOutcome & { sessionPath: string }>
  skipped: ChatImportOutcome[]
  failed: Array<ChatImportOutcome & { code: ChatImportFailureCode }>
}
