import { useEffect, type RefObject } from 'react'
import { clsx } from 'clsx'
import {
  AlertCircle,
  Brain,
  ChevronDown,
  CornerDownLeft,
  Cpu,
  FileText,
  Loader2,
  Paperclip,
  Send,
  Shield,
  X,
} from 'lucide-react'
import { t } from '../../../shared/i18n'
import {
  DEFAULT_PERMISSION_MODE,
  getPermissionModeDescription,
  getPermissionModeLabel,
} from '../components/permission-mode'
import { modelShortName } from './presentation'
import type { QuickChatController, QuickChatState } from './controller'

export function QuickChatComposer({
  state,
  controller,
  editor,
  onAttachFiles,
  picker,
  pickerOpen,
  children,
}: {
  state: QuickChatState
  controller: QuickChatController
  editor: RefObject<HTMLTextAreaElement | null>
  onAttachFiles: (files: File[]) => Promise<void>
  picker: React.ReactNode
  pickerOpen: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const newTask = state.mode === 'new'
  const minHeight = newTask ? 46 : 38
  const maxHeight = pickerOpen ? 80 : newTask ? 150 : 140
  useEffect(() => {
    const textarea = editor.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight)}px`
  }, [editor, state.draft, minHeight, maxHeight])

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const items = Array.from(e.clipboardData.items)
    const files: File[] = []
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile()
        if (file) files.push(file)
      }
    }
    if (files.length > 0) {
      e.preventDefault()
      void onAttachFiles(files)
    }
  }

  const attachmentsNode = state.attachments.length > 0 && (
    <div className="flex max-h-20 overflow-y-auto flex-wrap gap-1.5 pb-2 shrink-0">
      {state.attachments.map((att, index) => (
        <div
          key={`${att.name}-${index}`}
          className="group/chip flex items-center gap-1.5 px-2 py-1 rounded-lg border border-border bg-surface text-xs text-primary max-w-56 shadow-2xs"
          title={att.name}
        >
          {att.kind === 'image' ? (
            <img
              src={`data:${att.image.mimeType};base64,${att.image.data}`}
              alt={att.name}
              className="h-4 w-4 rounded object-cover shrink-0"
            />
          ) : (
            <FileText size={12} className="text-muted shrink-0" />
          )}
          <span className="truncate text-[11px]">{att.name}</span>
          <button
            type="button"
            onClick={() => controller.removeAttachment(index)}
            className="text-dim hover:text-primary transition-colors ml-0.5 p-0.5"
            aria-label={t('common.delete')}
          >
            <X size={10} />
          </button>
        </div>
      ))}
    </div>
  )

  const attachErrorNode = state.attachError && (
    <div className="mb-2 flex items-center justify-between gap-1.5 px-2.5 py-1 rounded-lg bg-error-bg/60 border border-error/30 text-[11px] text-error shrink-0">
      <div className="flex items-center gap-1.5 truncate">
        <AlertCircle size={12} className="shrink-0" />
        <span className="truncate">{state.attachError}</span>
      </div>
      <button
        type="button"
        onClick={() => controller.setAttachError(null)}
        className="text-error hover:text-primary p-0.5"
      >
        <X size={10} />
      </button>
    </div>
  )

  if (newTask) {
    return (
      <form
        className="flex-1 min-h-0 flex flex-col justify-between qc-no-drag overflow-hidden"
        onSubmit={(event) => {
          event.preventDefault()
          void controller.submit()
        }}
      >
        <div
          className={clsx(
            'px-4 pt-3 pb-1 flex flex-col min-h-0 overflow-y-auto',
            pickerOpen ? 'shrink-0' : 'flex-1'
          )}
        >
          {attachmentsNode}
          {attachErrorNode}
          <textarea
            ref={editor}
            rows={2}
            value={state.draft}
            disabled={state.selecting || state.sending || state.pickingWorkspace}
            aria-label={t('quickChat.message')}
            placeholder={t('quickChat.taskPlaceholder')}
            style={{ minHeight, maxHeight }}
            className={clsx(
              'font-chat w-full resize-none bg-transparent pt-0 pb-1 text-xs leading-relaxed text-primary placeholder:text-muted/60 outline-none disabled:opacity-50',
              !pickerOpen && 'flex-1'
            )}
            onChange={(event) => controller.setDraft(event.target.value)}
            onPaste={handlePaste}
          />
        </div>
        {picker}
        <div className="px-3.5 py-2 border-t border-border/40 bg-surface/25 flex items-center justify-between select-none shrink-0">
          {children}
        </div>
      </form>
    )
  }

  return (
    <form
      className={clsx(
        'rounded-xl border border-border/60 bg-card/85 shadow-xs focus-within:border-accent/40 focus-within:ring-1 focus-within:ring-accent/15 flex flex-col transition-all qc-no-drag p-2.5',
        pickerOpen && 'flex-1 min-h-0 overflow-hidden'
      )}
      onSubmit={(event) => {
        event.preventDefault()
        void controller.submit()
      }}
    >
      {attachmentsNode}
      {attachErrorNode}
      <textarea
        ref={editor}
        rows={1}
        value={state.draft}
        disabled={state.selecting || !state.binding}
        aria-label={t('quickChat.message')}
        placeholder={state.busy ? t('quickChat.steerPlaceholder') : t('quickChat.promptPlaceholder')}
        style={{ minHeight, maxHeight }}
        className="font-chat shrink-0 w-full resize-none bg-transparent pt-0.5 pb-2 text-xs leading-relaxed text-primary placeholder:text-muted/60 outline-none disabled:opacity-50"
        onChange={(event) => controller.setDraft(event.target.value)}
        onPaste={handlePaste}
      />
      {picker}
      <div className="pt-2 border-t border-border/40 flex items-center justify-between select-none">
        {children}
      </div>
    </form>
  )
}

/** Integrated action pills for model, thinking, permission, and submit directly inside composer card. */
export function ActionPills({
  state,
  anchorRef,
  modelPickerOpen,
  modelPickerTab,
  openPicker,
  onPickAttachment,
  onSubmit,
}: {
  state: QuickChatState
  anchorRef: RefObject<HTMLDivElement | null>
  modelPickerOpen: boolean
  modelPickerTab: 'model' | 'thinking'
  openPicker: (tab: 'model' | 'thinking') => void
  onPickAttachment: () => void
  onSubmit: () => void
}): React.JSX.Element {
  const locked = state.busy || !!state.request || state.stopping || state.switching
  const sendDisabled =
    state.sending ||
    state.loading ||
    state.selecting ||
    state.pickingWorkspace ||
    state.stopping ||
    !!state.request
  const { mode, binding } = state
  const newTask = mode === 'new'
  const hasAttachments = state.attachments.length > 0
  const hasContent = Boolean(state.draft.trim() || hasAttachments)
  const canSend = newTask ? hasContent : Boolean(binding && hasContent)
  const defaultModel = newTask ? state.context?.settings.defaultModel : null
  const rawModelId = state.preparedModel?.modelId || state.model?.id || defaultModel
  const rawModelName = state.preparedModel?.name || state.model?.name
  const modelLabel = rawModelId
    ? modelShortName(rawModelId, rawModelName)
    : t('models.selector.selectModel')
  const modelTitle = state.preparedModel
    ? `${state.preparedModel.provider} · ${state.preparedModel.modelId} (${t('quickChat.pendingModelHint')})`
    : state.model
      ? `${state.model.provider} · ${state.model.id}`
      : defaultModel
        ? `${state.context?.settings.defaultProvider ?? ''} · ${defaultModel} (${t('quickChat.defaultModelHint')})`
        : t('quickChat.modelUnconfirmedHint')
  const effectiveThinkingLevel =
    state.preparedThinkingLevel ??
    state.thinkingLevel ??
    (newTask ? state.context?.settings.defaultThinkingLevel : null)
  const thinkingDisplay = effectiveThinkingLevel
    ? effectiveThinkingLevel.charAt(0).toUpperCase() + effectiveThinkingLevel.slice(1)
    : null
  const thinkingLabel = thinkingDisplay
    ? `${t('quickChat.thinking')} · ${thinkingDisplay}`
    : t('quickChat.thinking')
  const thinkingTitle = thinkingDisplay
    ? t('thinking.effortWithLevel', { level: thinkingDisplay })
    : t('quickChat.modelUnconfirmedHint')
  const activeMode =
    (newTask ? state.context?.settings.permissionMode : state.permissionMode) ??
    DEFAULT_PERMISSION_MODE
  const permissionLabel = getPermissionModeLabel(activeMode)
  const permissionTitle = newTask
    ? `${permissionLabel} · ${t('quickChat.permissionAppliesOnSend')}`
    : getPermissionModeDescription(t, activeMode, '')

  return (
    <div className="w-full flex items-center justify-between gap-2 select-none">
      <div ref={anchorRef} className="relative flex flex-1 flex-wrap items-center gap-1.5 min-w-0">
        <button
          type="button"
          disabled={locked}
          onClick={() => openPicker('model')}
          className={clsx(
            'flex items-center gap-1.5 max-w-[240px] px-2.5 py-1 rounded-md border text-[11px] font-medium transition-colors',
            modelPickerOpen && modelPickerTab === 'model'
              ? 'bg-card border-border-strong ring-1 ring-border-strong text-primary'
              : 'bg-surface/60 border-border hover:bg-surface-hover hover:border-border-strong text-secondary hover:text-primary',
            locked && 'opacity-50 cursor-not-allowed'
          )}
          title={modelTitle}
        >
          <Cpu size={12} className="text-accent shrink-0" />
          <span className="truncate">{modelLabel}</span>
          <ChevronDown
            size={10}
            className={clsx(
              'text-dim transition-transform shrink-0',
              modelPickerOpen && modelPickerTab === 'model' && 'rotate-180'
            )}
          />
        </button>

        <button
          type="button"
          disabled={locked}
          onClick={() => openPicker('thinking')}
          className={clsx(
            'flex items-center gap-1.5 max-w-36 px-2.5 py-1 rounded-md border text-[11px] font-medium transition-colors',
            modelPickerOpen && modelPickerTab === 'thinking'
              ? 'bg-card border-border-strong ring-1 ring-border-strong text-primary'
              : 'bg-surface/60 border-border hover:bg-surface-hover hover:border-border-strong text-secondary hover:text-primary',
            locked && 'opacity-50 cursor-not-allowed'
          )}
          title={thinkingTitle}
        >
          <Brain size={11} className="text-accent shrink-0" />
          <span className="truncate">{thinkingLabel}</span>
          <ChevronDown
            size={10}
            className={clsx(
              'text-dim transition-transform shrink-0',
              modelPickerOpen && modelPickerTab === 'thinking' && 'rotate-180'
            )}
          />
        </button>

        <button
          type="button"
          disabled={locked}
          onClick={onPickAttachment}
          className={clsx(
            'flex items-center justify-center h-6 w-6 rounded-md border border-border bg-surface/60 hover:bg-surface-hover hover:border-border-strong text-secondary hover:text-primary transition-colors',
            locked && 'opacity-50 cursor-not-allowed'
          )}
          title={t('common.attachFile')}
          aria-label={t('common.attachFile')}
        >
          <Paperclip size={12} />
        </button>

        <span
          className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md border border-border/40 bg-surface/40 text-muted shrink-0"
          title={permissionTitle}
        >
          <Shield size={11} className="shrink-0 text-muted/80" />
          <span className="truncate">{permissionLabel}</span>
        </span>
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        <button
          type="button"
          disabled={!canSend || sendDisabled}
          onClick={onSubmit}
          title={state.busy ? t('quickChat.steerHint') : t('quickChat.enterHint')}
          className={clsx(
            'flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium transition-all shadow-xs shrink-0',
            state.busy ? 'bg-accent/90 hover:bg-accent text-white' : 'bg-accent hover:bg-accent-hover text-white',
            (!canSend || sendDisabled) && 'opacity-40 cursor-not-allowed'
          )}
        >
          {state.sending ? (
            <>
              <Loader2 size={11} className="animate-spin" />
              <span>{t('quickChat.sending')}</span>
            </>
          ) : state.busy ? (
            <>
              <CornerDownLeft size={11} />
              <span>{t('quickChat.steer')}</span>
              <span className="opacity-70 font-mono text-[10px] ml-0.5">↵</span>
            </>
          ) : (
            <>
              <Send size={11} />
              <span>{t('quickChat.send')}</span>
              <span className="opacity-70 font-mono text-[10px] ml-0.5">↵</span>
            </>
          )}
        </button>
      </div>
    </div>
  )
}
