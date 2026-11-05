import type { AppSettings, AttachmentReadResult, I18nEnvironment, ModelInfo, PermissionMode, PiExtensionUiRequest, PiResponseEvent, PiRpcEvent, PromptImage, SessionListItem, SessionRuntimeInfo, StreamingTextSnapshot, UserThemeRecord, Workspace } from './ipc-contracts'

export const QUICK_CHAT_CHANNELS = {
  context: 'quick-chat:context', select: 'quick-chat:select', snapshot: 'quick-chat:snapshot',
  submit: 'quick-chat:submit', respond: 'quick-chat:respond', hide: 'quick-chat:hide',
  openInMain: 'quick-chat:open-in-main', update: 'quick-chat:update',
  createSession: 'quick-chat:create-session', newDraft: 'quick-chat:new-draft',
  pickWorkspace: 'quick-chat:pick-workspace', stop: 'quick-chat:stop',
  listModels: 'quick-chat:list-models', setRuntimeModel: 'quick-chat:set-runtime-model',
  setRuntimeThinking: 'quick-chat:set-runtime-thinking',
  resolveHomeWorkspace: 'quick-chat:resolve-home-workspace',
  setPinned: 'quick-chat:set-pinned',
  pickAttachment: 'quick-chat:pick-attachment',
} as const
export interface QuickChatBinding {
  version: number
  runtime: SessionRuntimeInfo
}
export type QuickChatTarget = { runtimeId: string } | { workspaceId: string; sessionPath: string }
export interface QuickChatContext {
  /** Native main-process preference, including across renderer reloads. */
  pinned: boolean
  binding: QuickChatBinding | null
  runtimes: SessionRuntimeInfo[]
  sessions: SessionListItem[]
  workspaces: Workspace[]
  defaultWorkspaceId: string | null
  runtimeUpdatedAt: Record<string, number>
  settings: AppSettings
  i18nEnvironment: I18nEnvironment
  themes: UserThemeRecord[]
}
export interface QuickChatSnapshot {
  binding: QuickChatBinding
  messages: unknown[]
  streaming: StreamingTextSnapshot | null
  request: PiExtensionUiRequest | null
  /** The model the bound runtime actually runs, from the engine's get_state. */
  model: ModelInfo | null
  /** The thinking level the bound runtime actually uses, from get_state. */
  thinkingLevel: string | null
  /**
   * The permission mode the runtime started with, recorded at its last start.
   * Null when the runtime never started through the app's startup path (so a
   * fresh global setting is never presented as the runtime's own mode).
   */
  permissionMode: PermissionMode | null
}
export type QuickChatUpdate =
  | { type: 'binding'; binding: QuickChatBinding | null }
  | { type: 'event'; version: number; runtimeId: string; event: PiRpcEvent }
  | { type: 'approval'; version: number; request: PiExtensionUiRequest | null }
  | { type: 'settings'; settings: AppSettings }
  | { type: 'runtimes'; runtimes: SessionRuntimeInfo[]; updatedAt: Record<string, number> }
  | { type: 'runtime-state'; runtimeId: string }
  | { type: 'visibility'; visible: boolean }
  | { type: 'pinned'; pinned: boolean }
export interface QuickChatApi {
  getContext(): Promise<QuickChatContext>
  selectTarget(target: QuickChatTarget): Promise<QuickChatBinding>
  createSession(workspaceId: string): Promise<QuickChatBinding>
  newDraft(): Promise<void>
  pickWorkspace(): Promise<Workspace | null>
  /**
   * Resolve the popup's "no project" destination: the home directory as a
   * workspace, created in the background (never activating it in main) when
   * it does not already exist. Returns null only when the home path is
   * unavailable.
   */
  resolveHomeWorkspace(): Promise<Workspace | null>
  stop(version: number): Promise<void>
  getSnapshot(version: number): Promise<QuickChatSnapshot>
  submitText(input: {
    version: number
    text: string
    mode: 'prompt' | 'steer'
    /** Draft-selected model, applied to the runtime right after it starts. */
    model?: { provider: string; modelId: string }
    /** Draft-selected thinking level, applied right after the runtime starts. */
    thinkingLevel?: string
    images?: PromptImage[]
  }): Promise<PiResponseEvent | null>
  respond(input: { version: number; id: string; response: Record<string, unknown> }): Promise<void>
  hide(): Promise<void>
  pickAttachment(): Promise<AttachmentReadResult[]>
  openInMain(): Promise<void>
  /**
   * The engine's real model catalog: the bound runtime when live, else a
   * short-lived metadata query. The workspaceId is the popup's draft target:
   * the query runs from that project's path (home when null), so its config
   * and custom models apply — never main's active workspace.
   */
  listModels(workspaceId?: string | null): Promise<ModelInfo[]>
  /** Switch the bound runtime's model. Refused while busy, awaiting approval, stopping, or stopped. */
  setRuntimeModel(input: { version: number; provider: string; modelId: string }): Promise<PiResponseEvent | null>
  /** Switch the bound runtime's thinking level. Refused under the same guards. */
  setRuntimeThinking(input: { version: number; level: string }): Promise<PiResponseEvent | null>
  setPinned(pinned: boolean): Promise<void>
  onUpdate(callback: (update: QuickChatUpdate) => void): () => void
}

export interface QuickChatShortcutStatus {
  binding: string | null
  registered: boolean
}
