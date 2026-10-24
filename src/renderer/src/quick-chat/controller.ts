import { t } from '../../../shared/i18n'
import { promptRanWithoutAgent, promptRefusal, promptResultRefusal, type ModelInfo, type PermissionMode, type PiExtensionUiRequest, type PiPromptResultEvent, type PiRpcEvent } from '../../../shared/ipc-contracts'
import type { QuickChatApi, QuickChatBinding, QuickChatContext, QuickChatTarget, QuickChatUpdate } from '../../../shared/quick-chat'
import { parseAgentMessage, type DisplayMessage } from '../message-parsing'
import type { ComposerAttachment } from '../store'
import { composePrompt } from '../utils/compose-prompt'
import { readAttachmentBatch, type AttachmentSource } from '../utils/attachment-batch'
import { markUnansweredToolCallsRunning, settleRunningToolCall } from '../reattached-tool-calls'
import { placeStreamedDelta } from '../streamed-delta'
import { stripAnsi } from '../utils/strip-ansi'
import { thinkingLevels } from '../utils/thinking-levels'

export interface QuickChatState {
  context: QuickChatContext | null
  binding: QuickChatBinding | null
  mode: 'new' | 'session'
  workspaceId: string | null
  messages: DisplayMessage[]
  content: string
  thinking: string
  tools: Record<string, { name: string; running: boolean; error: boolean }>
  busy: boolean
  loading: boolean
  selecting: boolean
  sending: boolean
  answering: boolean
  stopping: boolean
  pickingWorkspace: boolean
  draft: string
  attachments: ComposerAttachment[]
  attachError: string | null
  isReadingAttachments: boolean
  request: PiExtensionUiRequest | null
  status: string
  error: string | null
  /** The model the bound runtime actually runs (from the snapshot); null when unconfirmed. */
  model: ModelInfo | null
  /** The thinking level the bound runtime actually uses; null when unconfirmed. */
  thinkingLevel: string | null
  /** The permission mode the bound runtime started with; null when never started. */
  permissionMode: PermissionMode | null
  /**
   * The model chosen in the current draft (new-task per project, or a stopped
   * session). Applied to the runtime on the next send; null means "use default".
   */
  preparedModel: { provider: string; modelId: string; name?: string } | null
  /** The thinking level chosen in the current draft, applied on the next send. */
  preparedThinkingLevel: string | null
  /** True while a runtime model/thinking switch is in flight. */
  switching: boolean
}
interface Draft { text: string; revision: number; attachments?: ComposerAttachment[]; model?: { provider: string; modelId: string; name?: string } | null; thinkingLevel?: string | null }
interface Delta { field: 'content' | 'thinking'; text: string; offset: number | undefined }
interface PendingPrompt {
  generation: number
  runtimeId: string
  starts: number
  key: string
  text: string
  attachments?: ComposerAttachment[]
  revision: number
  id?: string
  acknowledged: boolean
  earlyResults: Map<string, PiPromptResultEvent>
  refusal?: string
}
interface IdentifiedMessage extends DisplayMessage { sourceId?: string }

export function bindingDraftKey(binding: QuickChatBinding): string {
  const runtime = binding.runtime
  return runtime.sessionPath ? `${runtime.workspaceId}:${runtime.sessionPath}` : `runtime:${runtime.runtimeId}`
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
function messageKey(message: DisplayMessage): string {
  return JSON.stringify([message.role, message.timestamp, message.content, message.thinking, message.toolCallId, message.toolCalls?.map((tool) => tool.id)])
}
function parsedMessage(raw: unknown): IdentifiedMessage | null {
  const message = parseAgentMessage(raw)
  if (!message) return null
  const id = (raw as Record<string, unknown>).id
  return { ...message, sourceId: id == null ? undefined : String(id) }
}
function parsedMessages(raw: unknown[]): IdentifiedMessage[] {
  return raw.flatMap((item) => {
    const message = parsedMessage(item)
    return message ? [message] : []
  })
}
function mergeMessages(history: IdentifiedMessage[], live: IdentifiedMessage[]): IdentifiedMessage[] {
  const ids = new Set(history.map((message) => message.id))
  const liveIds = new Set(live.map((message) => message.id))
  const fallback = new Map<string, number>()
  const identified = new Map<string, number>()
  for (const message of history) {
    if (liveIds.has(message.id)) continue
    const counts = message.sourceId === undefined ? fallback : identified
    const key = messageKey(message)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const consume = (counts: Map<string, number>, key: string): boolean => {
    const count = counts.get(key) ?? 0
    if (!count) return false
    counts.set(key, count - 1)
    return true
  }
  return [...history, ...live.filter((message) => {
    if (ids.has(message.id)) return false
    const key = messageKey(message)
    // Two engine IDs denote distinct messages, even with identical text/timestamps.
    if (consume(fallback, key)) return false
    return message.sourceId !== undefined || !consume(identified, key)
  })]
}

/** This controller owns only the popup's pinned view and drafts, never main's queue. */
export class QuickChatController {
  private state: QuickChatState = {
    context: null, binding: null, mode: 'new', workspaceId: null, messages: [], content: '', thinking: '', tools: {}, busy: false,
    loading: true, selecting: false, sending: false, answering: false, stopping: false, pickingWorkspace: false, draft: '', attachments: [], attachError: null, isReadingAttachments: false, request: null, status: '', error: null,
    model: null, thinkingLevel: null, permissionMode: null, preparedModel: null, preparedThinkingLevel: null, switching: false,
  }
  private listeners = new Set<() => void>()
  private drafts = new Map<string, Draft>()
  private draftAliases = new Map<string, string>()
  private sendingRuntimes = new Set<string>()
  private sessionErrors = new Map<string, string>()
  private unsubscribe: (() => void) | null = null
  private generation = 0
  private contextLoad = 0
  private selection = 0
  private updateRevision = 0
  private eventRevision = 0
  private approvalRevision = 0
  private configRevision = 0
  private streamBoundary = 0
  private agentStarts = 0
  private latestPrompt: PendingPrompt | null = null
  private deltas: Delta[] = []
  private snapshotFlight: { generation: number; promise: Promise<void> } | null = null
  private reloadRequested = false
  private disposed = false
  private workspaceInitialized = false
  private enteringNewDraft = false
  private creatingSession: { workspaceId: string; key: string; runtimeId?: string } | null = null

  constructor(private readonly api: QuickChatApi) {}
  getState = (): QuickChatState => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private patch(patch: Partial<QuickChatState>): void {
    if (this.disposed) return
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
  private draftKey(): string {
    return this.state.mode === 'session' && this.state.binding
      ? bindingDraftKey(this.state.binding)
      : `new:${this.state.workspaceId ?? ''}`
  }
  start(): void {
    this.disposed = false
    this.unsubscribe = this.api.onUpdate((update) => this.onUpdate(update))
    void this.refreshContext(true)
  }
  dispose(): void {
    this.disposed = true
    this.generation++
    this.contextLoad++
    this.unsubscribe?.()
    this.unsubscribe = null
  }
  async refreshContext(initial = false): Promise<void> {
    const load = ++this.contextLoad
    const revision = this.updateRevision
    try {
      const context = await this.api.getContext()
      if (this.disposed || load !== this.contextLoad) return
      this.patch({ context, loading: false })
      if (!this.workspaceInitialized) {
        this.workspaceInitialized = true
        // The popup opens in "no project" state: drafts and sends target the
        // home directory until the user picks a folder (or a first send
        // materializes the home workspace). Main's active workspace is never
        // adopted — the popup must not move main's active-project pointer.
      } else if (this.state.workspaceId && !context.workspaces.some((workspace) => workspace.id === this.state.workspaceId)) {
        if (this.state.mode === 'new') {
          const draft = this.drafts.get(this.draftKey())
          if (draft) this.drafts.set('new:', draft)
        }
        this.patch({ workspaceId: null })
      }
      // An update delivered while getContext was in flight is newer than its binding.
      if (initial && revision === this.updateRevision) this.bind(context.binding)
    } catch (error) {
      if (load === this.contextLoad) this.patch({ error: errorText(error), loading: false })
    }
  }
  private bind(binding: QuickChatBinding | null): void {
    const previous = this.state.binding
    if (binding && this.creatingSession?.workspaceId === binding.runtime.workspaceId) {
      this.creatingSession.runtimeId = binding.runtime.runtimeId
      const draft = this.drafts.get(this.creatingSession.key)
      if (draft) {
        this.drafts.set(bindingDraftKey(binding), draft)
        this.drafts.delete(this.creatingSession.key)
      }
    }
    if (previous && binding && previous.runtime.runtimeId === binding.runtime.runtimeId) {
      const oldKey = bindingDraftKey(previous)
      const nextKey = bindingDraftKey(binding)
      if (oldKey !== nextKey) {
        this.draftAliases.set(oldKey, nextKey)
        if (this.drafts.has(oldKey)) {
          this.drafts.set(nextKey, this.drafts.get(oldKey)!)
          this.drafts.delete(oldKey)
        }
      }
    }
    if (previous && binding && previous.version === binding.version && previous.runtime.runtimeId === binding.runtime.runtimeId) {
      const activity = binding.runtime.activity
      this.patch({ binding, busy: activity === 'working' || activity === 'needs-approval' ? true : activity === 'completed' || activity === 'failed' ? false : this.state.busy })
      // A same-version status change (e.g. stopped -> starting -> running, or
      // the session file appearing) may carry the runtime's real model/thinking
      // now that the engine answers get_state. Refresh so the snapshot taken
      // after set_model lands instead of staying null forever.
      void this.reloadSnapshot()
      return
    }
    this.generation++
    this.eventRevision++
    this.approvalRevision++
    this.streamBoundary++
    this.deltas = []
    this.reloadRequested = false
    const draftKey = binding ? bindingDraftKey(binding) : `new:${this.state.workspaceId ?? ''}`
    const draftEntry = this.drafts.get(draftKey)
    this.patch({
      binding, mode: binding ? 'session' : this.enteringNewDraft ? 'new' : this.state.mode,
      workspaceId: binding?.runtime.workspaceId ?? this.state.workspaceId,
      messages: [], content: '', thinking: '', tools: {}, request: null,
      // Real runtime state is unconfirmed until the next snapshot arrives; the
      // draft's prepared config carries over so a stopped session keeps its
      // chosen model/thinking pending for the next send.
      model: null, thinkingLevel: null, permissionMode: null,
      preparedModel: draftEntry?.model ?? null,
      preparedThinkingLevel: draftEntry?.thinkingLevel ?? null,
      busy: binding?.runtime.activity === 'working' || binding?.runtime.activity === 'needs-approval',
      draft: binding ? (draftEntry?.text ?? '') : this.enteringNewDraft ? (this.drafts.get(`new:${this.state.workspaceId ?? ''}`)?.text ?? '') : this.state.draft,
      attachments: draftEntry?.attachments ?? [], attachError: null,
      loading: previous && previous.runtime.runtimeId === binding?.runtime.runtimeId ? false : !!binding, sending: !!this.creatingSession || !!binding && this.sendingRuntimes.has(binding.runtime.runtimeId),
      answering: false, stopping: false, switching: false, status: '', error: this.enteringNewDraft ? null : binding ? binding.runtime.error ?? this.sessionErrors.get(bindingDraftKey(binding)) ?? null : previous ? t('quickChat.targetUnavailable') : null,
    })
    if (binding) void this.reloadSnapshot()
  }
  async select(target: QuickChatTarget): Promise<void> {
    if (this.state.selecting || this.creatingSession) return
    const selection = ++this.selection
    this.patch({ selecting: true, error: null })
    try {
      const binding = await this.api.selectTarget(target)
      if (!this.disposed && selection === this.selection && (!this.state.binding || binding.version >= this.state.binding.version)) this.bind(binding)
    } catch (error) {
      if (selection === this.selection) this.patch({ error: errorText(error) })
    } finally {
      if (selection === this.selection) this.patch({ selecting: false })
    }
  }
  setWorkspace(workspaceId: string): void {
    if (this.state.mode !== 'new' || this.creatingSession || this.state.selecting) return
    if (!this.state.context?.workspaces.some((workspace) => workspace.id === workspaceId)) return
    const oldKey = this.draftKey()
    const nextKey = `new:${workspaceId}`
    if (this.state.workspaceId === null && !this.drafts.has(nextKey) && this.drafts.has(oldKey)) {
      this.drafts.set(nextKey, this.drafts.get(oldKey)!)
      this.drafts.delete(oldKey)
    }
    const nextDraft = this.drafts.get(nextKey)
    this.patch({
      workspaceId, draft: nextDraft?.text ?? '', attachments: nextDraft?.attachments ?? [], error: null, attachError: null,
      preparedModel: nextDraft?.model ?? null, preparedThinkingLevel: nextDraft?.thinkingLevel ?? null,
    })
  }
  setNoProject(): void {
    if (this.state.mode !== 'new' || this.creatingSession || this.state.selecting) return
    const oldKey = this.draftKey()
    const nextKey = `new:`
    // Return to the unassigned draft (the "no project" home bucket): keep the
    // text the user typed under the current folder, don't clobber a separate
    // no-project draft that already exists.
    if (this.state.workspaceId !== null && !this.drafts.has(nextKey) && this.drafts.has(oldKey)) {
      this.drafts.set(nextKey, this.drafts.get(oldKey)!)
      this.drafts.delete(oldKey)
    }
    const nextDraft = this.drafts.get(nextKey)
    this.patch({
      workspaceId: null, draft: nextDraft?.text ?? '', attachments: nextDraft?.attachments ?? [], error: null, attachError: null,
      preparedModel: nextDraft?.model ?? null, preparedThinkingLevel: nextDraft?.thinkingLevel ?? null,
    })
  }
  async newTask(): Promise<void> {
    if (this.state.mode === 'new' && !this.state.binding || this.state.selecting || this.creatingSession) return
    const selection = ++this.selection
    this.enteringNewDraft = true
    this.patch({ selecting: true, error: null })
    try {
      await this.api.newDraft()
      if (selection === this.selection && !this.disposed) {
        this.bind(null)
      }
    } catch (error) {
      if (selection === this.selection) this.patch({ error: errorText(error) })
    } finally {
      this.enteringNewDraft = false
      if (selection === this.selection) this.patch({ selecting: false })
    }
  }
  async pickWorkspace(): Promise<void> {
    if (this.state.pickingWorkspace || this.creatingSession || this.state.selecting || this.state.mode !== 'new') return
    this.patch({ pickingWorkspace: true, error: null })
    try {
      const workspace = await this.api.pickWorkspace()
      if (workspace) {
        await this.refreshContext()
        this.setWorkspace(workspace.id)
      }
    } catch (error) {
      this.patch({ error: errorText(error) })
    } finally { this.patch({ pickingWorkspace: false }) }
  }
  async stop(): Promise<void> {
    const { binding, busy, request, stopping } = this.state
    if (!binding || (!busy && !request) || stopping) return
    const generation = this.generation
    this.patch({ stopping: true, error: null })
    try {
      await this.api.stop(binding.version)
      if (generation === this.generation) await this.reloadSnapshot()
    } catch (error) {
      if (generation === this.generation) this.patch({ error: errorText(error) })
    } finally {
      if (generation === this.generation) this.patch({ stopping: false })
    }
  }
  setDraft(text: string): void {
    const key = this.draftKey()
    const previous = this.drafts.get(key)
    this.drafts.set(key, { ...(previous ?? { text, revision: 0 }), text, revision: (previous?.revision ?? 0) + 1 })
    this.patch({ draft: text })
  }
  addAttachments(items: ComposerAttachment[]): void {
    const existing = new Set(this.state.attachments.map((a) => a.path || a.name))
    const fresh = items.filter((a) => !existing.has(a.path || a.name))
    if (fresh.length === 0) return
    const next = [...this.state.attachments, ...fresh]
    const key = this.draftKey()
    const previous = this.drafts.get(key)
    this.drafts.set(key, { ...(previous ?? { text: this.state.draft, revision: 0 }), attachments: next })
    this.patch({ attachments: next, attachError: null })
  }
  removeAttachment(index: number): void {
    const next = this.state.attachments.filter((_, i) => i !== index)
    const key = this.draftKey()
    const previous = this.drafts.get(key)
    this.drafts.set(key, { ...(previous ?? { text: this.state.draft, revision: 0 }), attachments: next })
    this.patch({ attachments: next })
  }
  clearAttachments(): void {
    const key = this.draftKey()
    const previous = this.drafts.get(key)
    this.drafts.set(key, { ...(previous ?? { text: this.state.draft, revision: 0 }), attachments: [] })
    this.patch({ attachments: [], attachError: null })
  }
  setAttachError(error: string | null): void {
    this.patch({ attachError: error })
  }
  async readAttachments(sources: readonly AttachmentSource[]): Promise<void> {
    const key = this.draftKey()
    const generation = this.generation
    const batch = await readAttachmentBatch(sources, () =>
      !this.disposed && generation === this.generation && key === this.draftKey())
    if (!batch) return
    this.addAttachments(batch.attachments)
    this.setAttachError(batch.errors.length > 0 ? batch.errors.join('\n') : null)
  }
  async pickAttachment(): Promise<void> {
    if (this.state.isReadingAttachments || this.state.sending || this.state.pickingWorkspace) return
    const key = this.draftKey()
    const generation = this.generation
    this.patch({ isReadingAttachments: true, attachError: null })
    try {
      const picked = await this.api.pickAttachment()
      if (this.disposed || generation !== this.generation || key !== this.draftKey()) return
      if (picked && picked.length > 0) {
        this.addAttachments(picked.map((item) => ({ ...item, path: item.name })))
      }
    } catch (error) {
      if (generation === this.generation && key === this.draftKey()) this.patch({ attachError: errorText(error) })
    } finally {
      this.patch({ isReadingAttachments: false })
    }
  }
  /** Keep config picks with their draft unless an idle runtime can apply them. */
  private async changeConfig(
    command: (version: number) => Promise<unknown>,
    pending: Pick<Draft, 'model' | 'thinkingLevel'>,
    applied: Pick<Draft, 'model' | 'thinkingLevel'>,
  ): Promise<boolean> {
    const { binding, busy, request, stopping, switching, mode, sending } = this.state
    if (switching || sending || request || stopping) return false
    const key = this.draftKey()
    const write = (config: Pick<Draft, 'model' | 'thinkingLevel'>): void => {
      const entry = { ...(this.drafts.get(key) ?? { text: this.state.draft, revision: 0 }), ...config }
      this.drafts.set(key, entry)
      this.patch({ preparedModel: entry.model ?? null, preparedThinkingLevel: entry.thinkingLevel ?? null })
    }
    if (mode !== 'session' || !binding || binding.runtime.status !== 'running' || busy) {
      write(pending)
      return true
    }
    const generation = this.generation
    this.configRevision++
    this.patch({ switching: true, error: null })
    try {
      await command(binding.version)
      if (generation !== this.generation) return false
      this.configRevision++
      write(applied)
      await this.reloadSnapshot()
      return true
    } catch (error) {
      if (generation === this.generation) this.patch({ error: errorText(error) })
      return false
    } finally {
      if (generation === this.generation) this.patch({ switching: false })
    }
  }

  async setModelChoice(model: ModelInfo): Promise<boolean> {
    const preparedModel = { provider: model.provider, modelId: model.id, name: model.name || model.id }
    const pendingThinking = this.state.preparedThinkingLevel
    const resetThinking = pendingThinking && !thinkingLevels(model).includes(pendingThinking)
      ? { thinkingLevel: null } : {}
    return this.changeConfig(
      (version) => this.api.setRuntimeModel({ version, provider: preparedModel.provider, modelId: preparedModel.modelId }),
      { model: preparedModel, ...resetThinking },
      { model: null, ...resetThinking },
    )
  }

  async setThinkingChoice(level: string): Promise<boolean> {
    return this.changeConfig(
      (version) => this.api.setRuntimeThinking({ version, level }),
      { thinkingLevel: level },
      { thinkingLevel: null },
    )
  }
  async submit(): Promise<void> {
    const { draft, busy, loading, selecting, sending, request, mode, workspaceId, pickingWorkspace, stopping, attachments } = this.state
    const hasContent = Boolean(draft.trim() || attachments.length > 0)
    if (!hasContent || loading || selecting || sending || request || pickingWorkspace || stopping) return
    let binding = this.state.binding
    if (mode === 'session' && !binding) return
    if (mode === 'new' && workspaceId && !this.state.context?.workspaces.some((workspace) => workspace.id === workspaceId)) {
      this.patch({ error: t('quickChat.chooseProjectFirst') })
      return
    }
    let generation = this.generation
    let key = this.draftKey()
    const revision = this.drafts.get(key)?.revision ?? 0
    let runtimeId: string | null = null
    this.patch({ sending: true, error: null })
    try {
      if (mode === 'new') {
        // "No project" sends materialize the home workspace (never activating
        // it in main) and adopt it as the target, migrating the unassigned
        // draft into its bucket.
        if (!workspaceId) {
          const home = await this.api.resolveHomeWorkspace()
          if (this.disposed) return
          if (!home) {
            this.patch({ error: t('quickChat.noProjectUnavailable') })
            return
          }
          // The home workspace was created in main; adopt it in this popup's
          // context (it cannot be selected before it exists here).
          await this.refreshContext()
          if (this.disposed) return
          this.setWorkspace(home.id)
          key = this.draftKey()
        }
        const targetId = this.state.workspaceId!
        const creation: NonNullable<typeof this.creatingSession> = { workspaceId: targetId, key }
        this.creatingSession = creation
        const created = await this.api.createSession(targetId)
        if (this.disposed) return
        if (creation.runtimeId && this.state.binding?.runtime.runtimeId !== creation.runtimeId) throw new Error(t('quickChat.targetUnavailable'))
        if (this.state.binding?.runtime.runtimeId !== created.runtime.runtimeId) this.bind(created)
        binding = this.state.binding!
        generation = this.generation
        key = bindingDraftKey(binding)
        this.creatingSession = null
      }
      if (!binding) return
      runtimeId = binding.runtime.runtimeId
      const starts = this.agentStarts
      const { message, options } = composePrompt(draft, attachments)
      const prompt: PendingPrompt = { generation, runtimeId, starts, key, text: draft, attachments: [...attachments], revision, acknowledged: false, earlyResults: new Map() }
      if (!busy) this.latestPrompt = prompt
      this.sessionErrors.delete(key)
      this.sendingRuntimes.add(runtimeId)
      // Pending config from the draft rides this send (new-task first send and
      // stopped-session resume; a running-idle session's choice was already
      // applied live, so its draft carries none). It stays in the draft until
      // the engine's own state confirms it took effect — a busy steer must not
      // lose it.
      const draftEntry = this.drafts.get(key)
      const pendingModel = draftEntry?.model ?? null
      const pendingThinking = draftEntry?.thinkingLevel ?? null
      const response = await this.api.submitText({
        version: binding.version, text: message, mode: busy ? 'steer' : 'prompt',
        ...(options?.images ? { images: options.images } : {}),
        ...(pendingModel ? { model: { provider: pendingModel.provider, modelId: pendingModel.modelId } } : {}),
        ...(pendingThinking ? { thinkingLevel: pendingThinking } : {}),
      })
      prompt.id = response?.id
      prompt.acknowledged = true
      if (this.state.binding?.runtime.runtimeId === runtimeId) prompt.generation = this.generation
      const result = prompt.id ? prompt.earlyResults.get(prompt.id) : undefined
      prompt.earlyResults.clear()
      if (!busy && result) this.applyPromptResult(prompt, result)
      const refusal = promptRefusal(response)
      if (refusal) throw new Error(refusal.reason || t('quickChat.sendRejected'))
      if (prompt.refusal !== undefined) throw new Error(prompt.refusal || t('quickChat.sendRejected'))
      if (this.disposed) return
      const sentKey = this.draftAliases.get(key) ?? key
      const current = this.drafts.get(sentKey)
      if (current) {
        const textUnchanged = current.revision === revision && current.text === draft
        const remaining = (current.attachments ?? []).filter((item) => !attachments.includes(item))
        const next = {
          ...current,
          text: textUnchanged ? '' : current.text,
          attachments: remaining,
          revision: textUnchanged ? revision + 1 : current.revision,
        }
        this.drafts.set(sentKey, next)
        if (this.draftKey() === sentKey) this.patch({ draft: next.text, attachments: remaining })
      }
      // A non-steer send was the runtime's first: the draft config was applied
      // and the engine accepted the send, so it is no longer pending. This
      // must not depend on `generation`: the runtime-start binding events
      // (starting -> running) bump it mid-send, and the applied config is a
      // fact of this runtime regardless. A target switch mid-send leaves the
      // old draft's flag alone (the guard below compares the current key).
      if (!busy && response?.success && (pendingModel || pendingThinking)) {
        const clearedKey = this.draftAliases.get(key) ?? key
        const currentDraft = this.drafts.get(clearedKey)
        if (currentDraft) {
          this.drafts.set(clearedKey, { ...currentDraft, model: null, thinkingLevel: null })
          if (this.draftKey() === clearedKey) this.patch({ preparedModel: null, preparedThinkingLevel: null })
        }
      }
      if (generation !== this.generation) return
      if (promptRanWithoutAgent(response) && starts === this.agentStarts) this.patch({ busy: false })
      void this.reloadSnapshot()
    } catch (error) {
      const sentKey = this.draftAliases.get(key) ?? key
      this.sessionErrors.set(sentKey, errorText(error))
      if (this.draftKey() === sentKey || mode === 'new' && runtimeId === null) this.patch({ error: errorText(error) })
    } finally {
      this.creatingSession = null
      if (runtimeId) this.sendingRuntimes.delete(runtimeId)
      if (!runtimeId || this.state.binding?.runtime.runtimeId === runtimeId) this.patch({ sending: false })
    }
  }
  async answer(response: Record<string, unknown>): Promise<void> {
    const { binding, request, answering } = this.state
    if (!binding || !request || answering) return
    const generation = this.generation
    this.patch({ answering: true, error: null })
    try {
      await this.api.respond({ version: binding.version, id: request.id, response })
      if (generation === this.generation && this.state.request?.id === request.id) this.patch({ request: null })
    } catch (error) {
      if (generation === this.generation) this.patch({ error: errorText(error) })
    } finally {
      if (generation === this.generation) this.patch({ answering: false })
    }
  }
  cancelRequest(): Promise<void> {
    // A cancel is a real answer: the engine resolves { cancelled: true } to
    // undefined for select/input/editor. { value: '' } would be rejected for
    // select as a non-option, so it must never stand in for a cancel.
    return this.answer(this.state.request?.method === 'confirm' ? { confirmed: false } : { cancelled: true })
  }
  async hide(): Promise<void> {
    try { await this.api.hide() } catch (error) { this.patch({ error: errorText(error) }) }
  }
  async openInMain(): Promise<void> {
    try { await this.api.openInMain() } catch (error) { this.patch({ error: errorText(error) }) }
  }
  async retry(): Promise<void> {
    this.patch({ error: null })
    if (this.state.binding) await this.reloadSnapshot()
    else await this.refreshContext(true)
  }
  async reloadSnapshot(): Promise<void> {
    const binding = this.state.binding
    if (!binding) return
    const generation = this.generation
    if (this.snapshotFlight?.generation === generation) {
      this.reloadRequested = true
      return this.snapshotFlight.promise
    }
    const boundary = this.streamBoundary
    const eventRevision = this.eventRevision
    const approvalRevision = this.approvalRevision
    const bindingRevision = this.updateRevision
    const configRevision = this.configRevision
    const deltaStart = this.deltas.length
    const messagesAtStart = new Map(this.state.messages.map((message) => [message.id, message]))
    const promise = this.api.getSnapshot(binding.version).then((snapshot) => {
      if (this.disposed || generation !== this.generation || snapshot.binding.version < binding.version || snapshot.binding.runtime.runtimeId !== binding.runtime.runtimeId) return
      const busy = eventRevision === this.eventRevision ? snapshot.binding.runtime.activity === 'working' || snapshot.streaming !== null : this.state.busy
      const newerMessages = new Map(this.state.messages.filter((message) => messagesAtStart.get(message.id) !== message).map((message) => [message.id, message]))
      const history = parsedMessages(snapshot.messages).map((message) => newerMessages.get(message.id) ?? message)
      const patch: Partial<QuickChatState> = {
        binding: bindingRevision === this.updateRevision ? snapshot.binding : this.state.binding,
        messages: mergeMessages(busy ? markUnansweredToolCallsRunning(history) : history, this.state.messages), loading: false,
      }
      if (approvalRevision === this.approvalRevision) patch.request = snapshot.request
      if (eventRevision === this.eventRevision) patch.busy = snapshot.binding.runtime.activity === 'working' || snapshot.streaming !== null
      // Stream and settlement events do not change engine configuration.
      // Only a config switch or process transition invalidates these fields.
      if (configRevision === this.configRevision) {
        patch.model = snapshot.model
        patch.thinkingLevel = snapshot.thinkingLevel
        patch.permissionMode = snapshot.permissionMode
      }
      // A message commit/start is a fence: a snapshot for the old message cannot fill the next one.
      if (boundary === this.streamBoundary && snapshot.streaming) {
        let content = snapshot.streaming.content.length >= this.state.content.length ? snapshot.streaming.content : this.state.content
        let thinking = snapshot.streaming.thinking.length >= this.state.thinking.length ? snapshot.streaming.thinking : this.state.thinking
        for (const [index, delta] of this.deltas.entries()) {
          if (delta.offset === undefined && index < deltaStart) continue
          if (delta.field === 'content') content = placeStreamedDelta(content, delta.text, delta.offset) ?? content
          else thinking = placeStreamedDelta(thinking, delta.text, delta.offset) ?? thinking
        }
        patch.content = content
        patch.thinking = thinking
      }
      if (snapshot.binding.runtime.error) patch.error = snapshot.binding.runtime.error
      this.patch(patch)
    }).catch((error: unknown) => {
      if (generation === this.generation) this.patch({ error: errorText(error), loading: false })
    }).finally(() => {
      if (this.snapshotFlight?.promise !== promise) return
      this.snapshotFlight = null
      if (this.reloadRequested && generation === this.generation) {
        this.reloadRequested = false
        void this.reloadSnapshot()
      }
    })
    this.snapshotFlight = { generation, promise }
    return promise
  }
  private addMessage(raw: unknown, fresh = false): void {
    const message = parsedMessage(raw)
    if (!message) return
    this.patch({ messages: fresh && message.sourceId === undefined
      ? [...this.state.messages, message]
      : mergeMessages(this.state.messages, [message]) })
  }
  private applyPromptResult(prompt: PendingPrompt, event: PiPromptResultEvent): void {
    if (event.agentInvoked || prompt.generation !== this.generation || prompt.starts !== this.agentStarts) return
    const refusal = promptResultRefusal(event)
    if (refusal) {
      prompt.refusal = refusal.reason
      const key = this.draftAliases.get(prompt.key) ?? prompt.key
      const current = this.drafts.get(key)
      if (current?.revision === prompt.revision + 1 && current.text === '') {
        const retained = current.attachments ?? []
        const paths = new Set(retained.map((item) => item.path || item.name))
        const attachments = [
          ...(prompt.attachments ?? []).filter((item) => !paths.has(item.path || item.name)),
          ...retained,
        ]
        this.drafts.set(key, { ...current, text: prompt.text, attachments, revision: current.revision + 1 })
        this.patch({ draft: prompt.text, attachments })
      }
      this.patch({ error: refusal.reason || t('quickChat.sendRejected') })
    }
    this.streamBoundary++
    this.deltas = []
    this.patch({ busy: false, content: '', thinking: '', tools: {} })
    if (this.latestPrompt === prompt) this.latestPrompt = null
  }
  private onUpdate(update: QuickChatUpdate): void {
    if (update.type === 'visibility') {
      if (update.visible) {
        void this.refreshContext()
        if (this.state.binding) void this.reloadSnapshot()
      }
      return
    }
    if (update.type === 'runtimes') {
      const context = this.state.context
      if (context) {
        const settled = update.runtimes.some((runtime) =>
          (runtime.activity === 'completed' || runtime.activity === 'failed') &&
          context.runtimes.find((previous) => previous.runtimeId === runtime.runtimeId)?.activity !== runtime.activity)
        this.patch({ context: { ...context, runtimes: update.runtimes, runtimeUpdatedAt: update.updatedAt } })
        if (settled) void this.refreshContext()
      }
      return
    }
    if (update.type === 'runtime-state') {
      // A model/thinking switch made in the main window changed engine state
      // for that runtime. Only the bound view refreshes; the snapshot re-reads
      // get_state, so the label follows what the engine actually runs now.
      if (this.state.binding?.runtime.runtimeId === update.runtimeId) {
        this.configRevision++
        void this.reloadSnapshot()
      }
      return
    }
    if (update.type === 'binding') {
      const previous = this.state.binding
      if (previous?.runtime.status !== update.binding?.runtime.status) this.configRevision++
      this.updateRevision++
      this.eventRevision++
      this.bind(update.binding)
      if (!previous || !update.binding || previous.runtime.runtimeId !== update.binding.runtime.runtimeId || previous.runtime.sessionPath !== update.binding.runtime.sessionPath) void this.refreshContext()
      else if (this.state.context) this.patch({ context: { ...this.state.context, runtimes: this.state.context.runtimes.map((runtime) => runtime.runtimeId === update.binding!.runtime.runtimeId ? update.binding!.runtime : runtime) } })
    } else if (update.type === 'settings') {
      if (this.state.context) this.patch({ context: { ...this.state.context, settings: update.settings } })
      void this.refreshContext()
    } else if (update.type === 'approval') {
      if (update.version !== this.state.binding?.version) return
      this.approvalRevision++
      this.patch({ request: update.request })
    } else {
      if (update.version !== this.state.binding?.version || update.runtimeId !== this.state.binding.runtime.runtimeId) return
      this.eventRevision++
      this.onEvent(update.event)
    }
  }
  private onEvent(event: PiRpcEvent): void {
    switch (event.type) {
      case 'agent_start':
        this.agentStarts++
        this.streamBoundary++
        this.deltas = []
        this.patch({ busy: true, content: '', thinking: '', tools: {}, status: '', error: null })
        break
      case 'message_start':
        if (event.message.role === 'user') this.addMessage(event.message, true)
        break
      case 'message_update': {
        this.patch({ busy: true })
        const delta = event.assistantMessageEvent
        if (delta.type === 'text_delta' || delta.type === 'thinking_delta') {
          const field = delta.type === 'text_delta' ? 'content' : 'thinking'
          const entry: Delta = { field, text: delta.delta ?? '', offset: delta.offset }
          this.deltas.push(entry)
          const text = placeStreamedDelta(this.state[field], entry.text, entry.offset)
          if (text === null) void this.reloadSnapshot()
          else this.patch({ [field]: text })
        }
        break
      }
      case 'message_end':
        this.addMessage(event.message, event.message.role !== 'user')
        if (event.message.role === 'assistant') {
          this.streamBoundary++
          this.deltas = []
          this.patch({ content: '', thinking: '' })
        }
        break
      case 'tool_execution_start':
      case 'tool_execution_update':
      case 'tool_execution_end':
        this.patch({ tools: { ...this.state.tools, [event.toolCallId]: { name: event.toolName, running: event.type !== 'tool_execution_end', error: event.type === 'tool_execution_end' && event.isError } } })
        if (event.type === 'tool_execution_end') this.patch({ messages: settleRunningToolCall(this.state.messages, event.toolCallId, event.isError) })
        break
      case 'turn_end':
        this.patch({ messages: mergeMessages(this.state.messages, parsedMessages([event.message, ...event.toolResults])) })
        void this.reloadSnapshot()
        break
      case 'agent_end':
        this.patch({ messages: mergeMessages(this.state.messages, parsedMessages(event.messages)) })
        this.streamBoundary++
        this.deltas = []
        this.patch({ busy: false, content: '', thinking: '', tools: {}, status: '' })
        void this.reloadSnapshot()
        break
      case 'status_change': {
        const binding = this.state.binding!
        if (event.status !== binding.runtime.status) this.configRevision++
        if (event.status === 'stopped' || event.status === 'error') {
          this.streamBoundary++
          this.deltas = []
          void this.reloadSnapshot()
        }
        this.patch({ binding: { ...binding, runtime: { ...binding.runtime, ...event } }, ...(event.status === 'stopped' || event.status === 'error' ? { busy: false, content: '', thinking: '', tools: {} } : {}), ...(event.error ? { error: event.error } : {}) })
        break
      }
      case 'prompt_result': {
        const prompt = this.latestPrompt
        if (!prompt || !event.id) break
        if (prompt.runtimeId === this.state.binding?.runtime.runtimeId) {
          if (!prompt.acknowledged) prompt.earlyResults.set(event.id, event)
          else if (event.id === prompt.id) this.applyPromptResult(prompt, event)
        }
        void this.reloadSnapshot()
        break
      }
      case 'response':
        if (!event.success) this.patch({ error: event.error || t('quickChat.sendRejected') })
        break
      case 'extension_error':
        this.patch({ error: event.error })
        break
      case 'command_output':
        this.patch({ messages: [...this.state.messages, { id: `command-${this.eventRevision}`, role: 'system', content: stripAnsi(event.text), timestamp: Date.now() }] })
        break
      case 'compaction_start':
        this.patch({ status: t('quickChat.compacting') })
        break
      case 'compaction_end':
        this.patch({ status: '', ...(event.errorMessage ? { error: event.errorMessage } : {}) })
        break
      case 'auto_retry_start':
        this.patch({ status: t('quickChat.retrying', { attempt: event.attempt, total: event.maxAttempts }) })
        break
      case 'auto_retry_end':
        this.patch({ status: '', ...(event.finalError ? { error: event.finalError } : {}) })
        break
      case 'extension_ui_request':
        // Blocking ownership comes only from the dedicated approval update, not the raw engine event.
        if (event.method === 'notify') this.patch({ status: event.message ?? event.title ?? '' })
        else if (event.method === 'setStatus') this.patch({ status: event.statusText ?? '' })
        break
    }
  }
}
