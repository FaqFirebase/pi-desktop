import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { clsx } from 'clsx'
import { ArrowLeft, ChevronDown, Loader2, X } from 'lucide-react'
import type { SubagentInspectLine, SubagentTask } from '../../../shared/subagent-task'
import { useAppStore } from '../store'
import { groupToolMessages, prepareChatMessages } from '../message-grouping'
import { NowContext } from '../utils/relative-time'
import { useSubagentTranscript } from '../hooks/use-subagent-transcript'
import type { TranscriptView } from '../subagent-transcript-view'
import { MessageBubble, ToolGroupBubble } from './message-bubble'
import { SubagentStatusIcon, SubagentTaskRow } from './subagent-task-row'

/** Distance from the bottom, in px, that still counts as "following the end". */
const STICK_TO_BOTTOM_PX = 24

/** Right-side Tasks panel: the chat's subagents, and one subagent's live transcript. */
export function SubagentPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const tasks = useAppStore((state) => state.subagentTasks)
  const selectedId = useAppStore((state) => state.selectedSubagentTaskId)
  const selected = selectedId ? tasks.find((task) => task.id === selectedId) ?? null : null
  return selected ? <SubagentTranscript task={selected} /> : <SubagentTaskList tasks={tasks} onClose={onClose} />
}

function SubagentTaskList({ tasks, onClose }: { tasks: SubagentTask[]; onClose: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const [finishedOpen, setFinishedOpen] = useState(false)
  const running = tasks.filter((task) => task.status === 'running')
  const finished = tasks.filter((task) => task.status !== 'running')
  const select = (id: string): void => useAppStore.getState().selectSubagentTask(id)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-3">
        <span className="text-xs font-medium text-secondary">{t('chat.subagentPanel.title')}</span>
        <button
          type="button"
          onClick={onClose}
          className="flex h-6 w-6 items-center justify-center rounded text-faint hover:text-muted"
          title={t('chat.subagentPanel.close')}
          aria-label={t('chat.subagentPanel.close')}
        >
          <X size={13} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-2">
        {tasks.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-dim">{t('chat.subagentPanel.empty')}</p>
        ) : (
          <>
            {running.length > 0 && (
              <section>
                <h3 className="px-3 pb-1 text-[11px] font-medium text-dim">{t('chat.subagentPanel.running')}</h3>
                {running.map((task) => <SubagentTaskRow key={task.id} task={task} onSelect={select} />)}
              </section>
            )}
            {finished.length > 0 && (
              <section className={clsx(running.length > 0 && 'mt-3')}>
                <button
                  type="button"
                  onClick={() => setFinishedOpen((open) => !open)}
                  className="flex w-full items-center gap-1 px-3 pb-1 text-[11px] font-medium text-dim hover:text-secondary"
                  aria-expanded={finishedOpen}
                >
                  <span>{t('chat.subagentPanel.finished')}</span>
                  <span className="tabular-nums">{finished.length}</span>
                  <ChevronDown size={11} className={clsx('transition-transform duration-150', finishedOpen ? 'rotate-0' : '-rotate-90')} />
                </button>
                {finishedOpen && finished.map((task) => <SubagentTaskRow key={task.id} task={task} onSelect={select} />)}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function SubagentTranscript({ task }: { task: SubagentTask }): React.JSX.Element {
  const { t } = useTranslation()
  const view = useSubagentTranscript(task)
  const scrollRef = useRef<HTMLDivElement>(null)
  const followEnd = useRef(true)

  // Follow new content unless the user scrolled up to read.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && followEnd.current) el.scrollTop = el.scrollHeight
  }, [view])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2">
        <button
          type="button"
          onClick={() => useAppStore.getState().selectSubagentTask(null)}
          className="flex h-6 w-6 items-center justify-center rounded text-faint hover:text-muted"
          title={t('chat.subagentPanel.back')}
          aria-label={t('chat.subagentPanel.back')}
        >
          <ArrowLeft size={13} />
        </button>
        <SubagentStatusIcon status={task.status} />
        <span className="shrink-0 text-xs font-medium text-secondary">{task.agent}</span>
        {task.label && <span className="min-w-0 flex-1 truncate text-xs text-dim" title={task.label}>{task.label}</span>}
      </div>
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget
          followEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_TO_BOTTOM_PX
        }}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-3"
      >
        <TranscriptBody task={task} view={view} />
      </div>
    </div>
  )
}

function TranscriptBody({ task, view }: { task: SubagentTask; view: TranscriptView }): React.JSX.Element {
  const { t } = useTranslation()
  switch (view.kind) {
    case 'loading':
      return (
        <div className="flex items-center gap-2 text-xs text-dim">
          <Loader2 size={12} className="animate-spin" />
          {t('chat.subagentPanel.loading')}
        </div>
      )
    case 'unavailable':
      return (
        <p className="text-xs text-dim">
          {task.transcriptRef.kind === 'none' ? t('chat.subagentPanel.liveViewUnavailable') : t('chat.subagentPanel.transcriptUnavailable')}
        </p>
      )
    case 'progress':
      return <ProgressCard task={task} />
    case 'messages':
      return <TranscriptMessages view={view} />
    case 'lines':
      return <TranscriptLines view={view} />
  }
}

function RefreshFailedNote({ show }: { show: boolean }): React.JSX.Element | null {
  const { t } = useTranslation()
  return show ? <p className="mb-2 text-[11px] text-warning">{t('chat.subagentPanel.refreshFailed')}</p> : null
}

function TranscriptMessages({ view }: { view: Extract<TranscriptView, { kind: 'messages' }> }): React.JSX.Element {
  const { t } = useTranslation()
  const items = useMemo(() => groupToolMessages(prepareChatMessages(view.messages), t, false), [view.messages, t])
  return (
    // The side panel sits outside the chat's ticking NowContext; one value per render is enough here.
    <NowContext.Provider value={Date.now()}>
      <RefreshFailedNote show={view.refreshFailed} />
      {items.map((item) =>
        item.kind === 'toolGroup' ? (
          <ToolGroupBubble key={item.id} title={item.title} messages={item.messages} />
        ) : (
          <MessageBubble key={item.message.id} message={item.message} readOnly />
        )
      )}
    </NowContext.Provider>
  )
}

function TranscriptLines({ view }: { view: Extract<TranscriptView, { kind: 'lines' }> }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="space-y-1.5 text-xs">
      <RefreshFailedNote show={view.refreshFailed} />
      {view.lines.map((line, index) => <InspectLine key={index} line={line} />)}
      {view.finalOutput && (
        <div className="mt-3 border-t border-border pt-2">
          <div className="mb-1 text-[11px] font-medium text-dim">{t('chat.subagentPanel.finalOutput')}</div>
          <div className="whitespace-pre-wrap break-words text-secondary">{view.finalOutput}</div>
        </div>
      )}
    </div>
  )
}

function InspectLine({ line }: { line: SubagentInspectLine }): React.JSX.Element {
  if (line.kind === 'text') {
    return <div className={clsx('whitespace-pre-wrap break-words', line.role === 'user' ? 'text-primary' : 'text-secondary')}>{line.text}</div>
  }
  return (
    <div className={clsx('truncate font-jetbrains text-[11px]', line.isError ? 'text-error' : 'text-muted')} title={line.text}>
      {line.name ? `${line.name}: ` : ''}
      {line.text}
    </div>
  )
}

function ProgressCard({ task }: { task: SubagentTask }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="space-y-2 text-xs">
      {task.currentTool && <div className="font-jetbrains text-muted">{task.currentTool}</div>}
      {task.recentOutput && (
        <pre className="whitespace-pre-wrap break-words rounded border border-border bg-surface/50 p-2 font-jetbrains text-[11px] text-muted">
          {task.recentOutput.join('\n')}
        </pre>
      )}
      <p className="text-dim">{t('chat.subagentPanel.progressOnly')}</p>
    </div>
  )
}
