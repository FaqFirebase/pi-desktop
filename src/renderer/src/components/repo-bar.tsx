import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, AlertTriangle, Boxes, GitPullRequest, Plus, Rocket } from 'lucide-react'
import { clsx } from 'clsx'
import { useAppStore } from '../store'
import type { LinkedRepoStatus } from '../../../shared/ipc-contracts'
import { t } from '../../../shared/i18n'
import { formatIpcError } from '../utils/ipc-error'
import { createStaleGuard } from '../utils/stale-guard'
import { subscribeWorktreeRefresh } from '../utils/worktree-refresh'
import { ShipAllDialog } from './ship-all-dialog'

/** Same cadence as the Git action bar: one status read per repository. */
const LINKED_STATUS_POLL_MS = 5_000

function changeText(row: LinkedRepoStatus): string {
  if (!row.exists) return t('repoSets.bar.missing')
  return row.changedFiles > 0 ? t('repoSets.bar.changed', { count: row.changedFiles }) : t('repoSets.bar.clean')
}

/**
 * The repositories of a linked task, under the tab bar. Selecting one shows
 * it in the diff, file, and git panels; each row also shows its branch, its
 * changes, and its pull request. Add repo and Ship all act on the whole task.
 */
export function RepoBar(): React.JSX.Element | null {
  const { t } = useTranslation()
  const workspace = useAppStore((state) => state.activeWorkspace)
  const addRepoToLinkedTask = useAppStore((state) => state.addRepoToLinkedTask)
  const task = workspace?.linkedTask
  const workspaceId = task ? workspace.id : null
  const repoCount = task?.repos.length ?? 0
  const [rows, setRows] = useState<LinkedRepoStatus[]>([])
  const [error, setError] = useState<string | null>(null)
  const [shipOpen, setShipOpen] = useState(false)
  const guard = useRef(createStaleGuard())

  const refresh = useCallback(async (): Promise<void> => {
    if (!workspaceId) return
    const isCurrent = guard.current.begin()
    try {
      const next = await window.piDesktop.linkedTask.status(workspaceId)
      if (!isCurrent()) return
      setRows(next)
      setError(null)
    } catch (err) {
      if (isCurrent()) setError(formatIpcError(err))
    }
  }, [workspaceId])

  useEffect(() => {
    setRows([])
    setError(null)
    setShipOpen(false)
  }, [workspaceId])

  // A repository added to the task changes the count: read the bar again.
  useEffect(() => {
    if (!workspaceId) return
    void refresh()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, LINKED_STATUS_POLL_MS)
    const requests = guard.current
    return () => {
      requests.begin()
      window.clearInterval(timer)
    }
  }, [refresh, workspaceId, repoCount])

  useEffect(() => workspaceId ? subscribeWorktreeRefresh(refresh, false) : undefined, [refresh, workspaceId])

  if (!task || !workspace) return null

  const focus = async (name: string): Promise<void> => {
    try {
      await window.piDesktop.linkedTask.focusRepo(workspace.id, name)
      await refresh()
    } catch (err) {
      setError(formatIpcError(err))
    }
  }

  return (
    <div role="region" aria-label={t('repoSets.bar.ariaLabel')} className="flex h-8 shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border/70 bg-app px-2">
      <span className="mr-1 flex shrink-0 items-center gap-1 text-[10px] uppercase tracking-wide text-faint" title={task.setName}>
        <Boxes size={12} aria-hidden="true" />
        {task.mode === 'isolated' ? t('repoSets.mode.isolated.short') : t('repoSets.mode.inPlace.short')}
      </span>
      {rows.map((row) => (
        <div
          key={row.name}
          className={clsx(
            'flex shrink-0 items-center rounded border text-[11px] transition-colors',
            row.focused ? 'border-accent/60 bg-accent-bg/20 text-primary' : 'border-border text-muted hover:bg-surface-hover hover:text-secondary',
          )}
        >
          <button
            type="button"
            onClick={() => void focus(row.name)}
            aria-pressed={row.focused}
            title={row.workPath}
            className="flex items-center gap-1.5 px-2 py-0.5"
          >
            <span className="font-medium">{row.name}</span>
            {row.role === 'main' && <span className="rounded bg-highlight px-1 text-[9px] uppercase text-faint">{t('repoSets.bar.main')}</span>}
            <span className="max-w-40 truncate text-faint">{row.branch ?? t('conveyor.detachedBranch')}</span>
            <span className={clsx(!row.exists ? 'text-error' : row.changedFiles > 0 ? 'text-warning' : 'text-faint')}>
              {changeText(row)}
            </span>
            {row.sourceWasDirty && (
              <span title={t('repoSets.bar.sourceWasDirty')} aria-label={t('repoSets.bar.sourceWasDirty')} role="img">
                <AlertTriangle size={11} className="text-warning" aria-hidden="true" />
              </span>
            )}
          </button>
          {row.pullRequestUrl && (
            <button
              type="button"
              onClick={() => void window.piDesktop.system.openExternal(row.pullRequestUrl!)}
              className="mr-1 rounded p-0.5 text-faint hover:bg-highlight hover:text-primary"
              title={t('repoSets.bar.openPullRequest')}
              aria-label={t('repoSets.bar.openPullRequestAriaLabel', { name: row.name })}
            >
              <GitPullRequest size={11} />
            </button>
          )}
        </div>
      ))}
      {error && (
        <span role="alert" className="flex min-w-0 shrink items-center gap-1 text-[11px] text-error" title={error}>
          <AlertCircle size={12} className="shrink-0" aria-hidden="true" />
          <span className="truncate">{error}</span>
        </span>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={() => void addRepoToLinkedTask()}
          className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-muted transition-colors hover:bg-surface-hover hover:text-primary"
          title={t('repoSets.bar.addRepositoryTitle')}
        >
          <Plus size={12} aria-hidden="true" />
          {t('repoSets.bar.addRepository')}
        </button>
        <button
          type="button"
          onClick={() => setShipOpen(true)}
          className="flex items-center gap-1 rounded bg-accent px-2 py-0.5 text-[11px] font-medium text-white transition-colors hover:bg-accent-hover"
          title={t('repoSets.bar.shipAllTitle')}
        >
          <Rocket size={12} aria-hidden="true" />
          {t('repoSets.bar.shipAll')}
        </button>
      </div>
      {shipOpen && (
        <ShipAllDialog
          workspaceId={workspace.id}
          rows={rows}
          defaultTitle={workspace.name}
          onClose={() => setShipOpen(false)}
          onShipped={refresh}
        />
      )}
    </div>
  )
}
