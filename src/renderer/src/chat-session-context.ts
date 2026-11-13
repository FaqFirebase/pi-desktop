import { createContext, useContext, type ReactNode } from 'react'
import type { AgentEngineKind, AppSettings, FileSearchResult, ModelInfo, PermissionMode, PiExtensionUiRequest, PiStatus, VoiceStatus } from '../../shared/ipc-contracts'
import type { GuiCommand, PiCommand } from '../../shared/pi-command'
import type { ComposerAttachment, ComposerDraft } from './store'
import type { QueuedPrompt } from './send-queue'
import type { AttachmentBatch } from './utils/attachment-batch'

export interface ChatModelBindings {
  scopeKey: string
  status: PiStatus['status']
  model: ModelInfo | null
  thinkingLevel: string | null
  pendingModel: { provider: string; modelId: string; name?: string } | null
  pendingThinkingLevel: string | null
  /** Defaults describe a new draft, never an unconfirmed saved runtime. */
  useDefaults: boolean
  locked: boolean
  open: boolean
  setOpen(open: boolean): void
  list(): Promise<ModelInfo[]>
  select(model: ModelInfo): Promise<void>
  selectThinking(level: string): Promise<void>
  cycle(): Promise<void>
}

export interface ChatApprovalBindings {
  request: PiExtensionUiRequest | null
  notify: PiExtensionUiRequest | null
  answering: boolean
  respond(id: string, response: Record<string, unknown>): Promise<void> | void
  cancel(): Promise<void> | void
  dismissNotify(): void
  /** A popup hides its window; main hides only its unanswered prompt. */
  hideSurface?: () => void
}

export interface ChatComposerBindings {
  /** Opaque owner identity: shared controls never derive it from main selection. */
  scopeKey: string
  active: boolean
  loading: boolean
  streaming: boolean
  sending: boolean
  focusRequested: boolean
  requestFocus(): void
  clearFocusRequest(): void
  pendingInsert: { text: string; replace?: boolean } | null
  clearPendingInsert?(): void
  readDraft(): ComposerDraft
  saveDraft(draft: ComposerDraft): void
  /** Host-side draft replacement: send acknowledgement or rejection recovery. */
  draftVersion?: number
  history: readonly string[]
  historyBlocked?: boolean
  recordPrompt(text: string): void
  /** True means this view consumed the submitted draft, not that an agent ran. */
  submit(text: string, attachments: ComposerAttachment[], intent: 'send' | 'send-now'): Promise<boolean>
  stop(): Promise<void> | void
  escape: 'abort' | 'hide'
  hide?(): Promise<void> | void
  searchFiles(query: string): Promise<FileSearchResult[]>
  pickAttachments(): Promise<AttachmentBatch>
  getPathForFile?(file: File): string
  commands: PiCommand[]
  guiCommands: Array<GuiCommand & { run(): void }>
  queue?: {
    prompts: readonly QueuedPrompt[]
    held: boolean
    remove(id: string): void
    sendNow(id: string): Promise<void>
  }
  openNotes?: () => void
  searchWorkspace?: () => void
  runCouncil?: (text: string) => Promise<void>
  adornment?: ReactNode
}

export interface ChatSessionBindings {
  engine: AgentEngineKind
  settings: AppSettings
  permissionMode: PermissionMode | null
  setPermissionMode?: (mode: PermissionMode) => Promise<void> | void
  models: ChatModelBindings
  approval: ChatApprovalBindings
  composer: ChatComposerBindings
  voice: {
    loadStatus(): Promise<VoiceStatus>
    openSettings(): Promise<void> | void
    globalShortcuts: boolean
  }
}

export const ChatSessionContext = createContext<ChatSessionBindings | null>(null)

export function useChatSession(): ChatSessionBindings {
  const session = useContext(ChatSessionContext)
  if (!session) throw new Error('Chat controls require a session provider')
  return session
}
