import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { clsx } from 'clsx'
import { Download, Loader2 } from 'lucide-react'
import { AGENT_ENGINE_KIND_LIST, type AgentEngineKind } from '../../../shared/ipc-contracts'
import {
  CHAT_IMPORT_SOURCES,
  CHAT_IMPORT_SOURCE_LABELS,
  type ChatImportFailureCode,
  type ChatImportListing,
  type ChatImportOutcome,
  type ChatImportProgress,
  type ChatImportResult,
  type ChatImportSource,
} from '../../../shared/chat-import'
import { agentEngineLabel } from '../../../shared/agent-engine-label'
import { useAppStore } from '../store'
import { formatIpcError } from '../utils/ipc-error'
import { formatRelativeTime } from '../utils/format-relative-time'
import { formatFileSize } from '../utils/format-file-size'
import { groupChatImportItems, isSelectableChat, toggleGroupSelection } from '../utils/chat-import-view'

const TAB_CLASS = 'rounded-md px-2 py-1 text-xs transition-colors'
const TAB_ACTIVE_CLASS = 'bg-surface border border-border-strong text-primary'
const TAB_IDLE_CLASS = 'text-dim hover:text-primary'
const BADGE_CLASS = 'shrink-0 rounded bg-card px-1.5 py-0.5 text-[10px] text-dim'
const PERCENT = 100

function failureReason(code: ChatImportFailureCode, t: TFunction): string {
  switch (code) {
    case 'invalid-path':
      return t('settings.chatImport.failure.invalidPath')
    case 'folder-missing':
      return t('settings.chatImport.failure.folderMissing')
    case 'unreadable':
      return t('settings.chatImport.failure.unreadable')
    case 'no-messages':
      return t('settings.chatImport.failure.noMessages')
    case 'write-failed':
      return t('settings.chatImport.failure.writeFailed')
  }
}

/**
 * Settings section that copies Claude Code and Codex chats into Pi or OMP
 * sessions. Each chat lands in its own project folder's session list; the
 * source files are only read.
 */
export function ChatImportSettings(): React.JSX.Element {
  const { t } = useTranslation()
  const refreshSessionList = useAppStore((state) => state.refreshSessionList)
  const [source, setSource] = useState<ChatImportSource>(CHAT_IMPORT_SOURCES[0])
  const [engine, setEngine] = useState<AgentEngineKind | null>(null)
  const [listing, setListing] = useState<ChatImportListing | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<ChatImportProgress | null>(null)
  const [result, setResult] = useState<ChatImportResult | null>(null)
  // Only the latest list request may set the list.
  const listRequest = useRef(0)

  const fetchListing = useCallback(async (nextSource: ChatImportSource, nextEngine: AgentEngineKind | null) => {
    const request = ++listRequest.current
    setLoading(true)
    setError(null)
    try {
      const next = await window.piDesktop.chatImport.list({ source: nextSource, engine: nextEngine ?? undefined })
      if (request !== listRequest.current) return
      setListing(next)
      setEngine(next.engine)
    } catch (err) {
      if (request !== listRequest.current) return
      setListing(null)
      setError(formatIpcError(err))
    } finally {
      if (request === listRequest.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchListing(CHAT_IMPORT_SOURCES[0], null)
  }, [fetchListing])

  useEffect(() => window.piDesktop.chatImport.onProgress(setProgress), [])

  const reload = useCallback(
    (nextSource: ChatImportSource, nextEngine: AgentEngineKind | null) => {
      setSource(nextSource)
      setEngine(nextEngine)
      setSelected(new Set())
      setResult(null)
      void fetchListing(nextSource, nextEngine)
    },
    [fetchListing],
  )

  const groups = useMemo(() => groupChatImportItems(listing?.items ?? []), [listing])
  const titles = useMemo(() => new Map((listing?.items ?? []).map((item) => [item.sourcePath, item.title])), [listing])

  const runImport = useCallback(async () => {
    if (!listing || selected.size === 0) return
    // List order, so the files import in the order they are shown.
    const sourcePaths = groups.flatMap((group) => group.items.map((item) => item.sourcePath)).filter((path) => selected.has(path))
    setRunning(true)
    setResult(null)
    setError(null)
    setProgress({ done: 0, total: sourcePaths.length, currentTitle: null })
    try {
      setResult(await window.piDesktop.chatImport.run({ source: listing.source, engine: listing.engine, sourcePaths }))
      setSelected(new Set())
      await fetchListing(listing.source, listing.engine)
      void refreshSessionList()
    } catch (err) {
      setError(formatIpcError(err))
    } finally {
      setRunning(false)
      setProgress(null)
    }
  }, [fetchListing, groups, listing, refreshSessionList, selected])

  const outcomeTitle = (outcome: ChatImportOutcome): string =>
    outcome.title ?? titles.get(outcome.sourcePath) ?? t('settings.chatImport.untitled')
  const now = Date.now()

  return (
    <div className="space-y-4">
      {engine && <p className="text-xs text-dim">{t('settings.chatImport.intro', { agent: agentEngineLabel(engine) })}</p>}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1" role="tablist">
          {CHAT_IMPORT_SOURCES.map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={source === option}
              disabled={running}
              onClick={() => reload(option, engine)}
              className={clsx(TAB_CLASS, source === option ? TAB_ACTIVE_CLASS : TAB_IDLE_CLASS)}
            >
              {CHAT_IMPORT_SOURCE_LABELS[option]}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-dim">{t('settings.chatImport.engine')}</span>
          <div className="flex gap-1">
            {AGENT_ENGINE_KIND_LIST.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={engine === option}
                disabled={running}
                onClick={() => reload(source, option)}
                className={clsx(TAB_CLASS, engine === option ? TAB_ACTIVE_CLASS : TAB_IDLE_CLASS)}
              >
                {agentEngineLabel(option)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {listing && (
        <p className="break-all text-[11px] text-faint">{t('settings.chatImport.sourceRoot', { path: listing.sourceRoot })}</p>
      )}

      {error && <div className="rounded-md border border-error-bg bg-error-bg px-2 py-1 text-xs text-error">{error}</div>}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-dim">
          <Loader2 size={13} className="animate-spin" /> {t('settings.chatImport.loading')}
        </div>
      ) : listing && groups.length === 0 ? (
        <div className="text-sm text-dim">{t('settings.chatImport.empty')}</div>
      ) : (
        <div className="max-h-96 space-y-3 overflow-y-auto pr-1">
          {groups.map((group) => {
            const selectable = group.items.filter(isSelectableChat)
            const allSelected = selectable.length > 0 && selectable.every((item) => selected.has(item.sourcePath))
            return (
              <div key={group.cwd ?? ''} className="space-y-1">
                <label className="flex items-center gap-2 text-xs text-secondary">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    disabled={running || selectable.length === 0}
                    onChange={() => setSelected((current) => toggleGroupSelection(current, group))}
                    aria-label={t('settings.chatImport.selectFolder')}
                    className="accent-accent"
                  />
                  <span className="min-w-0 truncate font-medium">{group.cwd ?? t('settings.chatImport.unknownFolder')}</span>
                </label>
                {group.items.map((item) => {
                  const canSelect = isSelectableChat(item)
                  return (
                    <label key={item.sourcePath} className={clsx('ml-5 flex items-center gap-2 text-xs', canSelect ? 'text-primary' : 'text-faint')}>
                      <input
                        type="checkbox"
                        checked={selected.has(item.sourcePath)}
                        disabled={running || !canSelect}
                        onChange={(event) => {
                          const checked = event.target.checked
                          setSelected((current) => {
                            const next = new Set(current)
                            if (checked) next.add(item.sourcePath)
                            else next.delete(item.sourcePath)
                            return next
                          })
                        }}
                        className="accent-accent"
                      />
                      <span className="min-w-0 flex-1 truncate">{item.title ?? t('settings.chatImport.untitled')}</span>
                      {item.alreadyImported && <span className={BADGE_CLASS}>{t('settings.chatImport.alreadyImported')}</span>}
                      {!canSelect && <span className={BADGE_CLASS}>{t('settings.chatImport.folderMissing')}</span>}
                      <span className="shrink-0 text-faint">{formatRelativeTime(item.modifiedAt, now)}</span>
                      <span className="w-14 shrink-0 text-right text-faint">{formatFileSize(item.sizeBytes)}</span>
                    </label>
                  )
                })}
              </div>
            )
          })}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void runImport()}
          disabled={running || selected.size === 0}
          className="flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-xs text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
        >
          {running ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
          {t('settings.chatImport.import', { count: selected.size })}
        </button>
        {progress && (
          <div className="min-w-0 flex-1">
            <div className="h-1 w-full overflow-hidden rounded bg-card">
              <div
                className="h-full bg-accent transition-all"
                style={{ width: `${progress.total > 0 ? Math.round((progress.done / progress.total) * PERCENT) : 0}%` }}
              />
            </div>
            <div className="mt-1 truncate text-[10px] text-faint">
              {t('settings.chatImport.progress', { done: progress.done, total: progress.total })}
              {progress.currentTitle && ` · ${progress.currentTitle}`}
            </div>
          </div>
        )}
      </div>

      {result && (
        <div className="space-y-2 text-xs">
          <ResultList label={t('settings.chatImport.results.imported', { count: result.imported.length })} outcomes={result.imported} titleOf={outcomeTitle} />
          <ResultList label={t('settings.chatImport.results.skipped', { count: result.skipped.length })} outcomes={result.skipped} titleOf={outcomeTitle} />
          <ResultList
            label={t('settings.chatImport.results.failed', { count: result.failed.length })}
            outcomes={result.failed}
            titleOf={outcomeTitle}
            reasonOf={(outcome) => failureReason(outcome.code, t)}
          />
        </div>
      )}
    </div>
  )
}

function ResultList<T extends ChatImportOutcome>({
  label,
  outcomes,
  titleOf,
  reasonOf,
}: {
  label: string
  outcomes: T[]
  titleOf: (outcome: T) => string
  reasonOf?: (outcome: T) => string
}): React.JSX.Element {
  return (
    <div>
      <div className="text-secondary">{label}</div>
      {outcomes.length > 0 && (
        <ul className="ml-4 mt-1 space-y-0.5 text-dim">
          {outcomes.map((outcome) => (
            <li key={outcome.sourcePath} className="truncate">
              {titleOf(outcome)}
              {reasonOf && <span className="text-error"> · {reasonOf(outcome)}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
