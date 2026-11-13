import { t } from '../../../shared/i18n'
import { isRuntimeBusy, promptRanWithoutAgent, promptRefusal, promptResultRefusal, type ModelInfo, type PermissionMode, type PiExtensionUiRequest, type PiPromptResultEvent, type PiRpcEvent } from '../../../shared/ipc-contracts'
import type { QuickChatApi, QuickChatBinding, QuickChatContext, QuickChatTarget, QuickChatUpdate } from '../../../shared/quick-chat'
import type { DisplayMessage } from '../message-parsing'
import type { ComposerAttachment, ComposerDraft } from '../store'
import { appendPromptHistory, applyChatStreamUpdate, applyChatToolExecution, chatEventNotice, keepNoticesInPlace, mergeChatMessages, parseChatMessage, parseChatMessages, type ChatToolCall } from '../chat-session-state'
import { composePrompt } from '../utils/compose-prompt'
import { markUnansweredToolCallsRunning, settleRunningToolCall } from '../reattached-tool-calls'
import { placeStreamedDelta } from '../streamed-delta'
import { thinkingLevels } from '../utils/thinking-levels'

export interface QuickChatState {
  visible: boolean
  history: string[]
  draftVersion: number
  notify: PiExtensionUiRequest | null
  context: QuickChatContext | null
  binding: QuickChatBinding | null
  mode: 'new' | 'session'
  workspaceId: string | null
  messages: DisplayMessage[]
  content: string
  thinking: string
  tools: Map<string, ChatToolCall>
  busy: boolean
  loading: boolean
  selecting: boolean
  sending: boolean
  answering: boolean
  stopping: boolean
  pickingWorkspace: boolean
  draft: string
  attachments: ComposerAttachment[]
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
/** State a live update can change while a background read is in flight; the read must not overwrite it. */
type LiveField = 'binding' | 'busy' | 'request' | 'config'
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

const NOTICE_ID_PREFIX = 'notice-'
const STEER_COMMAND = 'steer'
function isNotice(message: DisplayMessage): boolean {
  return message.id.startsWith(NOTICE_ID_PREFIX)
}

export function bindingDraftKey(binding: QuickChatBinding): string {
  return `runtime:${binding.runtime.runtimeId}`
}
function newDraftKey(workspaceId: string | null): string {
  return `new:${workspaceId ?? ''}`
}
/** The live stream area emptied, as at a message or turn boundary. */
function idleStream(): Pick<QuickChatState, 'content' | 'thinking' | 'tools'> {
  return { content: '', thinking: '', tools: new Map() }
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** This controller owns only the popup's bound view and drafts, never main's queue. */
export class QuickChatController {
  private state: QuickChatState = {
    context: null, binding: null, visible: true, history: [], draftVersion: 0, notify: null, mode: 'new', workspaceId: null, messages: [], content: '', thinking: '', tools: new Map(), busy: false,
    loading: true, selecting: false, sending: false, answering: false, stopping: false, pickingWorkspace: false, draft: '', attachments: [], request: null, status: '', error: null,
    model: null, thinkingLevel: null, permissionMode: null, preparedModel: null, preparedThinkingLevel: null, switching: false,
  }
  private listeners = new Set<() => void>()
  private drafts = new Map<string, Draft>()
  private histories = new Map<string, string[]>()
  private draftAliases = new Map<string, string>()
  private sendingRuntimes = new Set<string>()
  private sessionErrors = new Map<string, string>()
  private unsubscribe: (() => void) | null = null
  private generation = 0
  private contextLoad = 0
  private selection = 0
  // Parts of the state changed by live updates while a background read was open.
  private openReads = new Set<Set<LiveField>>()
  private streamBoundary = 0
  private agentStarts = 0
  private latestPrompt: PendingPrompt | null = null
  private deltas: Delta[] = []
  private snapshotFlight: { generation: number; promise: Promise<void> } | null = null
  private reloadRequested = false
  private disposed = false
  private enteringNewDraft = false
  private creatingSession: { workspaceId: string; key: string; runtimeId?: string } | null = null
  private noticeCount = 0
  // The first context picks main's project once; later the user's choice wins.
  private workspaceDefaulted = false

  constructor(private readonly api: QuickChatApi) {}
  getState = (): QuickChatState => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  /** Opens a read; the returned set collects every live field touched until it closes. */
  private openRead(): Set<LiveField> {
    const touched = new Set<LiveField>()
    this.openReads.add(touched)
    return touched
  }
  private touch(...fields: LiveField[]): void {
    for (const touched of this.openReads) for (const field of fields) touched.add(field)
  }
  /** Stream text from before this point can no longer fill the live bubble. */
  private fenceStream(): void {
    this.streamBoundary++
    this.deltas = []
  }
  private patch(patch: Partial<QuickChatState>): void {
    if (this.disposed) return
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
  getScopeKey = (): string => this.state.mode === 'session' && this.state.binding
    ? bindingDraftKey(this.state.binding)
    : newDraftKey(this.state.workspaceId)
  readDraft = (): ComposerDraft => ({ text: this.state.draft, attachments: this.state.attachments })
  saveDraft(draft: ComposerDraft, scopeKey = this.getScopeKey()): void {
    if (scopeKey !== this.getScopeKey()) return
    const previous = this.drafts.get(scopeKey)
    this.drafts.set(scopeKey, {
      ...(previous ?? { revision: 0 }), ...draft,
      revision: (previous?.revision ?? 0) + (previous?.text === draft.text ? 0 : 1),
    })
    this.patch({ draft: draft.text, attachments: draft.attachments })
  }
  recordPrompt(text: string): void {
    const key = this.getScopeKey()
    const history = appendPromptHistory(this.histories.get(key) ?? [], text)
    this.histories.set(key, history)
    this.patch({ history })
  }
  // Stable identity: the toast's dismiss timer must not restart on each render.
  dismissNotify = (): void => {
    this.patch({ notify: null })
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
    const touched = this.openRead()
    try {
      const context = await this.api.getContext()
      if (this.disposed || load !== this.contextLoad) return
      this.patch({ context, loading: false })
      if (this.state.workspaceId && !context.workspaces.some((workspace) => workspace.id === this.state.workspaceId)) {
        if (this.state.mode === 'new') {
          const draft = this.drafts.get(this.getScopeKey())
          if (draft) this.drafts.set(newDraftKey(null), draft)
        }
        this.patch({ workspaceId: null })
      }
      // A new task starts in main's current project, so its model list and
      // file search work at once; "No project" stays one click away.
      if (!this.workspaceDefaulted && this.state.mode === 'new' && this.state.workspaceId === null && context.defaultWorkspaceId) {
        this.workspaceDefaulted = true
        this.setWorkspace(context.defaultWorkspaceId)
      }
      // An update delivered while getContext was in flight is newer than its binding.
      if (initial && !touched.has('binding')) this.bind(context.binding)
    } catch (error) {
      if (load === this.contextLoad) this.patch({ error: errorText(error), loading: false })
    } finally {
      this.openReads.delete(touched)
    }
  }
  private bind(binding: QuickChatBinding | null): void {
    const previous = this.state.binding
    if (binding && this.creatingSession?.workspaceId === binding.runtime.workspaceId) {
      this.creatingSession.runtimeId = binding.runtime.runtimeId
      this.draftAliases.set(this.creatingSession.key, bindingDraftKey(binding))
      const draft = this.drafts.get(this.creatingSession.key)
      if (draft) {
        this.drafts.set(bindingDraftKey(binding), draft)
        this.drafts.delete(this.creatingSession.key)
      }
      const history = this.histories.get(this.creatingSession.key)
      if (history) {
        this.histories.set(bindingDraftKey(binding), history)
        this.histories.delete(this.creatingSession.key)
      }
    }
    const sameRuntime = !!previous && !!binding && previous.runtime.runtimeId === binding.runtime.runtimeId
    if (sameRuntime && previous.version === binding.version) {
      const activity = binding.runtime.activity
      const settled = activity === 'completed' || activity === 'failed'
      this.patch({ binding, busy: isRuntimeBusy(activity) || (!settled && this.state.busy) })
      // The engine may answer get_state only now (it just started), so its real model shows.
      void this.reloadSnapshot()
      return
    }
    this.generation++
    this.touch('busy', 'request')
    this.fenceStream()
    this.reloadRequested = false
    const draftKey = binding ? bindingDraftKey(binding) : newDraftKey(this.state.workspaceId)
    const draftEntry = this.drafts.get(draftKey)
    const draft = binding || this.enteringNewDraft ? draftEntry?.text ?? '' : this.state.draft
    const error = this.enteringNewDraft ? null
      : binding ? binding.runtime.error ?? this.sessionErrors.get(draftKey) ?? null
        : previous ? t('quickChat.targetUnavailable') : null
    this.patch({
      binding, mode: binding ? 'session' : this.enteringNewDraft ? 'new' : this.state.mode,
      workspaceId: binding?.runtime.workspaceId ?? this.state.workspaceId,
      // A restart of the same runtime keeps its transcript until the next
      // snapshot replaces it, and keeps its toast until its own timer ends it.
      messages: sameRuntime ? this.state.messages : [], ...idleStream(), request: null,
      notify: sameRuntime ? this.state.notify : null,
      history: this.histories.get(draftKey) ?? [],
      // Real runtime state is unconfirmed until the next snapshot arrives; the
      // draft's prepared config carries over so a stopped session keeps its
      // chosen model/thinking pending for the next send.
      model: null, thinkingLevel: null, permissionMode: null,
      preparedModel: draftEntry?.model ?? null,
      preparedThinkingLevel: draftEntry?.thinkingLevel ?? null,
      busy: isRuntimeBusy(binding?.runtime.activity),
      draft,
      attachments: draftEntry?.attachments ?? [],
      loading: !sameRuntime && !!binding,
      sending: !!this.creatingSession || !!binding && this.sendingRuntimes.has(binding.runtime.runtimeId),
      answering: false, stopping: false, switching: false, status: '', error,
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
    if (this.state.context?.workspaces.some((workspace) => workspace.id === workspaceId)) this.enterNewDraft(workspaceId)
  }
  setNoProject(): void {
    this.enterNewDraft(null)
  }
  /** Switch the new-task target; a draft follows between a project and "No project" when the target has none. */
  private enterNewDraft(workspaceId: string | null): void {
    if (this.state.mode !== 'new' || this.creatingSession || this.state.selecting) return
    this.selection++
    const oldKey = this.getScopeKey()
    const nextKey = newDraftKey(workspaceId)
    const crossesNoProject = (this.state.workspaceId === null) !== (workspaceId === null)
    if (crossesNoProject && !this.drafts.has(nextKey) && this.drafts.has(oldKey)) {
      this.drafts.set(nextKey, this.drafts.get(oldKey)!)
      this.drafts.delete(oldKey)
    }
    const nextDraft = this.drafts.get(nextKey)
    this.patch({
      workspaceId, draft: nextDraft?.text ?? '', attachments: nextDraft?.attachments ?? [], error: null,
      history: this.histories.get(nextKey) ?? [],
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
  async pickWorkspace(): Promise<boolean> {
    if (this.state.pickingWorkspace || this.creatingSession || this.state.selecting || this.state.mode !== 'new') return false
    const generation = this.generation
    const selection = this.selection
    const key = this.getScopeKey()
    const isCurrent = (): boolean => !this.disposed && generation === this.generation && selection === this.selection && key === this.getScopeKey()
    this.patch({ pickingWorkspace: true, error: null })
    try {
      const workspace = await this.api.pickWorkspace()
      if (!workspace || !isCurrent()) return false
      await this.refreshContext()
      if (!isCurrent()) return false
      this.setWorkspace(workspace.id)
      return this.state.workspaceId === workspace.id
    } catch (error) {
      if (isCurrent()) this.patch({ error: errorText(error) })
      return false
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
  /** Keep config picks with their draft unless an idle runtime can apply them. */
  private async changeConfig(
    command: (version: number) => Promise<unknown>,
    pending: Pick<Draft, 'model' | 'thinkingLevel'>,
    applied: Pick<Draft, 'model' | 'thinkingLevel'>,
  ): Promise<boolean> {
    const { binding, busy, request, stopping, switching, mode, sending } = this.state
    if (switching || sending || request || stopping) return false
    const key = this.getScopeKey()
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
    this.touch('config')
    this.patch({ switching: true, error: null })
    try {
      await command(binding.version)
      if (generation !== this.generation) return false
      this.touch('config')
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
  async submit(): Promise<boolean> {
    const { draft, busy, loading, selecting, sending, request, mode, workspaceId, pickingWorkspace, stopping, attachments } = this.state
    const hasContent = Boolean(draft.trim() || attachments.length > 0)
    if (!hasContent || loading || selecting || sending || request || pickingWorkspace || stopping) return false
    let binding = this.state.binding
    if (mode === 'session' && !binding) return false
    if (mode === 'new' && workspaceId && !this.state.context?.workspaces.some((workspace) => workspace.id === workspaceId)) {
      this.patch({ error: t('quickChat.chooseProjectFirst') })
      return false
    }
    let generation = this.generation
    let key = this.getScopeKey()
    let textKey = key
    const revision = this.drafts.get(key)?.revision ?? 0
    let runtimeId: string | null = null
    this.patch({ sending: true, error: null })
    try {
      if (mode === 'new') {
        const created = await this.createSessionForSend(key)
        if (!created) return false
        binding = created.binding
        key = created.key
        textKey = created.textKey
        generation = this.generation
      }
      if (!binding) return false
      runtimeId = binding.runtime.runtimeId
      const starts = this.agentStarts
      const { message, options } = composePrompt(draft, attachments)
      const prompt: PendingPrompt = { generation, runtimeId, starts, key, text: draft, attachments: [...attachments], revision, acknowledged: false, earlyResults: new Map() }
      if (!busy) this.latestPrompt = prompt
      this.sessionErrors.delete(key)
      this.sendingRuntimes.add(runtimeId)
      // A draft's pending model or thinking level rides this send; an idle running
      // session applied its choice live, so its draft carries none.
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
      if (this.disposed) return false
      // Main applies the draft config only to a prompt; a send it turned into a
      // steer leaves the config pending for the next prompt.
      const configApplied = !!response?.success && response.command !== STEER_COMMAND && !!(pendingModel || pendingThinking)
      this.settleSentDraft({ key, textKey, text: draft, attachments, revision }, configApplied)
      if (generation === this.generation) {
        if (promptRanWithoutAgent(response) && starts === this.agentStarts) this.patch({ busy: false })
        void this.reloadSnapshot()
      }
      return true
    } catch (error) {
      const sentKey = this.draftAliases.get(key) ?? key
      this.sessionErrors.set(sentKey, errorText(error))
      if (this.getScopeKey() === sentKey || mode === 'new' && runtimeId === null) this.patch({ error: errorText(error) })
      return false
    } finally {
      this.creatingSession = null
      if (runtimeId) this.sendingRuntimes.delete(runtimeId)
      if (!runtimeId || this.state.binding?.runtime.runtimeId === runtimeId) this.patch({ sending: false })
    }
  }
  /**
   * Creates the runtime a new-task send goes to. A no-project send first asks for
   * a folder; the sent text may then stay in the no-project draft (`textKey`).
   */
  private async createSessionForSend(key: string): Promise<{ binding: QuickChatBinding; key: string; textKey: string } | null> {
    let textKey = key
    if (!this.state.workspaceId) {
      if (!await this.pickWorkspace()) return null
      key = this.getScopeKey()
      if (!this.drafts.has(textKey)) textKey = key
    }
    const creation: NonNullable<typeof this.creatingSession> = { workspaceId: this.state.workspaceId!, key }
    this.creatingSession = creation
    const created = await this.api.createSession(creation.workspaceId)
    if (this.disposed) return null
    if (creation.runtimeId && this.state.binding?.runtime.runtimeId !== creation.runtimeId) throw new Error(t('quickChat.targetUnavailable'))
    if (this.state.binding?.runtime.runtimeId !== created.runtime.runtimeId) this.bind(created)
    this.creatingSession = null
    const binding = this.state.binding!
    const sessionKey = bindingDraftKey(binding)
    return { binding, key: sessionKey, textKey: textKey === key ? sessionKey : textKey }
  }
  /** After an accepted send: record it in history, clear the sent text, and drop config the engine applied. */
  private settleSentDraft(sent: { key: string; textKey: string; text: string; attachments: ComposerAttachment[]; revision: number }, configApplied: boolean): void {
    const sentKey = this.draftAliases.get(sent.key) ?? sent.key
    const history = appendPromptHistory(this.histories.get(sentKey) ?? [], sent.text)
    this.histories.set(sentKey, history)
    if (this.getScopeKey() === sentKey) this.patch({ history })
    const textKey = this.draftAliases.get(sent.textKey) ?? sent.textKey
    const current = this.drafts.get(textKey)
    if (current) {
      // Text typed during the send is kept; only the sent text is cleared.
      const textUnchanged = current.revision === sent.revision && current.text === sent.text
      const remaining = (current.attachments ?? []).filter((item) => !sent.attachments.includes(item))
      const next = { ...current, text: textUnchanged ? '' : current.text, attachments: remaining, revision: textUnchanged ? sent.revision + 1 : current.revision }
      this.drafts.set(textKey, next)
      if (this.getScopeKey() === textKey) this.patch({ draft: next.text, attachments: remaining, draftVersion: this.state.draftVersion + 1 })
    }
    const sessionDraft = configApplied ? this.drafts.get(sentKey) : undefined
    if (sessionDraft) {
      this.drafts.set(sentKey, { ...sessionDraft, model: null, thinkingLevel: null })
      if (this.getScopeKey() === sentKey) this.patch({ preparedModel: null, preparedThinkingLevel: null })
    }
  }
  async answer(response: Record<string, unknown>): Promise<boolean> {
    const { binding, request, answering } = this.state
    if (!binding || !request || answering) return false
    const generation = this.generation
    this.patch({ answering: true, error: null })
    try {
      await this.api.respond({ version: binding.version, id: request.id, response })
      if (generation === this.generation && this.state.request?.id === request.id) this.patch({ request: null })
      return generation === this.generation
    } catch (error) {
      if (generation === this.generation) this.patch({ error: errorText(error) })
      return false
    } finally {
      if (generation === this.generation) this.patch({ answering: false })
    }
  }
  cancelRequest(): Promise<boolean> {
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
    const touched = this.openRead()
    const deltaStart = this.deltas.length
    const messagesAtStart = new Map(this.state.messages.map((message) => [message.id, message]))
    const promise = this.api.getSnapshot(binding.version).then((snapshot) => {
      if (!snapshot || this.disposed || generation !== this.generation || snapshot.binding.version < binding.version || snapshot.binding.runtime.runtimeId !== binding.runtime.runtimeId) return
      const busy = !touched.has('busy') ? snapshot.binding.runtime.activity === 'working' || snapshot.streaming !== null : this.state.busy
      const newerMessages = new Map(this.state.messages.filter((message) => messagesAtStart.get(message.id) !== message).map((message) => [message.id, message]))
      const history = parseChatMessages(snapshot.messages).map((message) => newerMessages.get(message.id) ?? message)
      const patch: Partial<QuickChatState> = {
        binding: touched.has('binding') ? this.state.binding : snapshot.binding,
        messages: keepNoticesInPlace(mergeChatMessages(busy ? markUnansweredToolCallsRunning(history) : history, this.state.messages), this.state.messages, isNotice), loading: false,
      }
      if (!touched.has('request')) patch.request = snapshot.request
      if (!touched.has('busy')) patch.busy = busy
      // Stream and settlement events do not change engine configuration.
      // Only a config switch or process transition invalidates these fields.
      if (!touched.has('config')) {
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
      this.openReads.delete(touched)
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
    const message = parseChatMessage(raw)
    if (!message) return
    // A snapshot can already include a tool message when its live commit
    // arrives. Its call IDs identify that occurrence; id-less prose still
    // appends so genuinely repeated answers are not collapsed.
    this.patch({ messages: fresh && message.sourceId === undefined && !message.toolCalls?.length
      ? [...this.state.messages, message]
      : mergeChatMessages(this.state.messages, [message]) })
  }
  /** Engine notices use the main chat's shared wording and rules. */
  private addNotice(event: PiRpcEvent): void {
    const content = chatEventNotice(event)
    if (!content) return
    this.noticeCount++
    this.patch({ messages: [...this.state.messages, { id: `${NOTICE_ID_PREFIX}${this.noticeCount}`, role: 'system', content, timestamp: Date.now() }] })
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
        if (this.getScopeKey() === key) this.patch({ draft: prompt.text, attachments, draftVersion: this.state.draftVersion + 1 })
      }
      this.patch({ error: refusal.reason || t('quickChat.sendRejected') })
    }
    this.fenceStream()
    this.patch({ busy: false, ...idleStream() })
    if (this.latestPrompt === prompt) this.latestPrompt = null
  }
  private onUpdate(update: QuickChatUpdate): void {
    if (update.type === 'visibility') {
      this.patch({ visible: update.visible })
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
      // A model or thinking switch made in main: re-read what the engine runs now.
      if (this.state.binding?.runtime.runtimeId === update.runtimeId) {
        this.touch('config')
        void this.reloadSnapshot()
      }
      return
    }
    if (update.type === 'binding') {
      const previous = this.state.binding
      if (previous?.runtime.status !== update.binding?.runtime.status) this.touch('config')
      this.touch('binding', 'busy')
      this.bind(update.binding)
      if (!previous || !update.binding || previous.runtime.runtimeId !== update.binding.runtime.runtimeId || previous.runtime.sessionPath !== update.binding.runtime.sessionPath) void this.refreshContext()
      else if (this.state.context) this.patch({ context: { ...this.state.context, runtimes: this.state.context.runtimes.map((runtime) => runtime.runtimeId === update.binding!.runtime.runtimeId ? update.binding!.runtime : runtime) } })
    } else if (update.type === 'themes') {
      if (this.state.context) this.patch({ context: { ...this.state.context, themes: update.themes } })
    } else if (update.type === 'settings') {
      if (this.state.context) this.patch({ context: { ...this.state.context, settings: update.settings } })
      void this.refreshContext()
    } else if (update.type === 'approval') {
      if (update.version !== this.state.binding?.version) return
      this.touch('request')
      this.patch({ request: update.request })
    } else {
      if (update.version !== this.state.binding?.version || update.runtimeId !== this.state.binding.runtime.runtimeId) return
      this.touch('busy')
      this.onEvent(update.event)
    }
  }
  private onEvent(event: PiRpcEvent): void {
    switch (event.type) {
      case 'agent_start':
        this.agentStarts++
        this.fenceStream()
        this.patch({ busy: true, ...idleStream(), status: '', error: null })
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
        }
        const next = applyChatStreamUpdate(this.state, delta)
        this.patch({ content: next.content, thinking: next.thinking, tools: next.tools })
        if (next.missingPrefix) void this.reloadSnapshot()
        break
      }
      case 'message_end':
        this.addMessage(event.message, event.message.role !== 'user')
        if (event.message.role === 'assistant') {
          this.fenceStream()
          this.patch({ content: '', thinking: '' })
        }
        this.addNotice(event)
        break
      case 'tool_execution_start':
      case 'tool_execution_update':
      case 'tool_execution_end':
        this.patch({ tools: applyChatToolExecution(this.state.tools, event) })
        if (event.type === 'tool_execution_end') this.patch({ messages: settleRunningToolCall(this.state.messages, event.toolCallId, event.isError) })
        break
      case 'turn_end':
        this.patch({ messages: mergeChatMessages(this.state.messages, parseChatMessages([event.message, ...event.toolResults])) })
        void this.reloadSnapshot()
        break
      case 'agent_end':
        this.patch({ messages: mergeChatMessages(this.state.messages, parseChatMessages(event.messages)) })
        this.fenceStream()
        this.patch({ busy: false, ...idleStream(), status: '' })
        void this.reloadSnapshot()
        break
      case 'status_change': {
        const binding = this.state.binding!
        if (event.status !== binding.runtime.status) this.touch('config')
        if (event.status === 'stopped' || event.status === 'error') {
          this.fenceStream()
          void this.reloadSnapshot()
        }
        this.patch({ binding: { ...binding, runtime: { ...binding.runtime, ...event } }, ...(event.status === 'stopped' || event.status === 'error' ? { busy: false, ...idleStream() } : {}), ...(event.error ? { error: event.error } : {}) })
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
      case 'compaction_start':
      case 'compaction_end':
      case 'auto_retry_start':
        this.addNotice(event)
        break
      case 'auto_retry_end':
        // The failed attempt's message_end already showed its error.
        if (!event.success) this.patch({ busy: false })
        break
      case 'extension_ui_request':
        // Blocking ownership comes only from the dedicated approval update, not the raw engine event.
        if (event.method === 'notify') this.patch({ notify: event })
        else if (event.method === 'setStatus') this.patch({ status: event.statusText ?? '' })
        break
    }
  }
}
