import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, CircleSlash, GitPullRequest, Loader2, RotateCcw, Rocket, X, XCircle } from 'lucide-react'
import type { LinkedRepoShipResult, LinkedRepoStatus, LinkedShipResult, LinkedShipStep } from '../../../shared/ipc-contracts'
import { t } from '../../../shared/i18n'
import { formatIpcError } from '../utils/ipc-error'
import { failedRepoNames, mergeShipResults } from '../utils/linked-ship-results'
import { PULL_REQUEST_BODY_TEMPLATE } from './git-conveyor-actions'

const FIELD = 'mt-1 w-full rounded border border-border-strong bg-app px-2 py-1.5 text-sm text-primary outline-none focus:border-focus'

function stepText(step: LinkedShipStep | undefined): string {
  switch (step) {
    case 'commit': return t('repoSets.ship.step.commit')
    case 'push': return t('repoSets.ship.step.push')
    case 'pullRequest': return t('repoSets.ship.step.pullRequest')
    case 'link': return t('repoSets.ship.step.link')
    case undefined: return ''
  }
}

function outcomeText(repo: LinkedRepoShipResult): string {
  switch (repo.outcome) {
    case 'shipped': return t('repoSets.ship.outcome.shipped')
    case 'unchanged': return t('repoSets.ship.outcome.unchanged')
    case 'missing': return t('repoSets.ship.outcome.missing')
    case 'failed': return t('repoSets.ship.outcome.failed', { step: stepText(repo.failedStep) })
  }
}

function OutcomeIcon({ repo }: { repo: LinkedRepoShipResult }): React.JSX.Element {
  if (repo.outcome === 'shipped') return <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-success" />
  if (repo.outcome === 'unchanged') return <CircleSlash size={13} className="mt-0.5 shrink-0 text-faint" />
  return <XCircle size={13} className="mt-0.5 shrink-0 text-error" />
}

/**
 * Ship a linked task: one commit message and one pull request text for every
 * repository with changes. New files stay out unless checked, the same rule
 * as a single commit. After a ship the dialog lists what happened in each
 * repository and can retry only the failed ones.
 */
export function ShipAllDialog({ workspaceId, rows, defaultTitle, onClose, onShipped }: {
  workspaceId: string
  rows: LinkedRepoStatus[]
  defaultTitle: string
  onClose: () => void
  onShipped: () => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation()
  const titleId = useId()
  const [message, setMessage] = useState('')
  const [title, setTitle] = useState(defaultTitle)
  const [body, setBody] = useState(PULL_REQUEST_BODY_TEMPLATE)
  const [chosenNewFiles, setChosenNewFiles] = useState<Record<string, string[]>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<LinkedShipResult | null>(null)
  const failed = result ? failedRepoNames(result) : []

  const toggleNewFile = (repo: string, path: string, chosen: boolean): void => {
    setChosenNewFiles((current) => {
      const files = (current[repo] ?? []).filter((file) => file !== path)
      return { ...current, [repo]: chosen ? [...files, path] : files }
    })
  }

  const ship = async (repos?: string[]): Promise<void> => {
    if (busy) return
    if (!message.trim()) {
      setError(t('conveyor.errors.commitMessageRequired'))
      return
    }
    if (!title.trim()) {
      setError(t('conveyor.errors.prTitleRequired'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const next = await window.piDesktop.linkedTask.ship(workspaceId, {
        message: message.trim(),
        title: title.trim(),
        body: body.trim(),
        newFiles: chosenNewFiles,
        ...(repos ? { repos } : {}),
      })
      setResult((previous) => repos && previous ? mergeShipResults(previous, next) : next)
    } catch (err) {
      setError(formatIpcError(err))
    } finally {
      setBusy(false)
      await onShipped()
    }
  }

  const close = (): void => {
    if (!busy) onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 px-4 pt-[8vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
      role="presentation"
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[84vh] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-border-strong bg-surface shadow-2xl"
        onSubmit={(event) => {
          event.preventDefault()
          void ship()
        }}
      >
        <div className="flex items-start justify-between border-b border-border px-4 py-3">
          <div>
            <h2 id={titleId} className="text-sm font-semibold text-primary">{t('repoSets.ship.title')}</h2>
            <p className="mt-0.5 text-xs text-dim">{t('repoSets.ship.intro')}</p>
          </div>
          <button type="button" onClick={close} disabled={busy} className="rounded p-1 text-muted hover:bg-surface-hover hover:text-primary disabled:opacity-50" aria-label={t('repoSets.dialog.closeAriaLabel')}>
            <X size={14} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {result ? (
            <ul className="space-y-1.5" aria-label={t('repoSets.ship.resultsLabel')}>
              {result.repos.map((repo) => (
                <li key={repo.name} className="flex items-start gap-2 rounded border border-border bg-app/50 px-2.5 py-2 text-xs">
                  <OutcomeIcon repo={repo} />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium text-secondary">{repo.name}</span>
                    <span className="ml-2 text-faint">{outcomeText(repo)}</span>
                    {repo.error && <span className="mt-1 block whitespace-pre-wrap break-words text-error">{repo.error}</span>}
                  </span>
                  {repo.pullRequestUrl && (
                    <button
                      type="button"
                      onClick={() => void window.piDesktop.system.openExternal(repo.pullRequestUrl!)}
                      className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted hover:bg-surface-hover hover:text-primary"
                      title={repo.pullRequestUrl}
                    >
                      <GitPullRequest size={11} aria-hidden="true" />
                      {t('repoSets.bar.openPullRequest')}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <>
              <label className="block text-xs text-muted">
                {t('conveyor.dialog.commitMessageLabel')}
                <textarea autoFocus rows={3} value={message} onChange={(event) => setMessage(event.target.value)} disabled={busy} className={`${FIELD} resize-y`} />
              </label>
              <label className="block text-xs text-muted">
                {t('conveyor.dialog.titleLabel')}
                <input value={title} onChange={(event) => setTitle(event.target.value)} disabled={busy} className={FIELD} />
              </label>
              <label className="block text-xs text-muted">
                {t('conveyor.dialog.descriptionLabel')}
                <textarea rows={5} value={body} onChange={(event) => setBody(event.target.value)} disabled={busy} className={`${FIELD} resize-y`} />
              </label>
              <fieldset className="min-w-0">
                <legend className="text-xs text-muted">{t('repoSets.ship.repositoriesLabel')}</legend>
                <ul className="mt-1 space-y-1.5">
                  {rows.map((row) => {
                    const chosen = chosenNewFiles[row.name] ?? []
                    return (
                      <li key={row.name} className="rounded border border-border bg-app/50 px-2.5 py-2 text-xs">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-secondary">{row.name}</span>
                          <span className="truncate text-faint">{row.branch ?? t('conveyor.detachedBranch')}</span>
                          <span className="ml-auto shrink-0 text-faint">
                            {!row.exists ? t('repoSets.bar.missing')
                              : row.changedFiles > 0 ? t('repoSets.bar.changed', { count: row.changedFiles }) : t('repoSets.bar.clean')}
                          </span>
                        </div>
                        {row.newFiles.length > 0 && (
                          <div className="mt-1.5">
                            <span className="text-[11px] text-muted">{t('conveyor.dialog.newFilesLabel')}</span>
                            <ul className="mt-1 max-h-28 space-y-0.5 overflow-y-auto rounded border border-border bg-app px-2 py-1">
                              {row.newFiles.map((path) => (
                                <li key={path}>
                                  <label className="flex min-w-0 items-center gap-2 py-0.5 text-xs text-secondary">
                                    <input
                                      type="checkbox"
                                      checked={chosen.includes(path)}
                                      onChange={(event) => toggleNewFile(row.name, path, event.target.checked)}
                                      disabled={busy}
                                      className="shrink-0 accent-accent"
                                    />
                                    <span className="min-w-0 truncate font-mono" title={path}>{path}</span>
                                  </label>
                                </li>
                              ))}
                            </ul>
                            {chosen.length < row.newFiles.length && (
                              <p className="mt-1 text-[11px] text-warning" role="status">
                                {t('conveyor.dialog.newFilesLeftOut', { count: row.newFiles.length - chosen.length })}
                              </p>
                            )}
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </fieldset>
            </>
          )}
          {error && <p role="alert" className="whitespace-pre-wrap break-words rounded border border-error/20 bg-error-bg px-3 py-2 text-xs text-error">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          {result ? (
            <>
              {failed.length > 0 && (
                <button type="button" onClick={() => void ship(failed)} disabled={busy} className="flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-xs text-muted hover:bg-surface-hover hover:text-primary disabled:opacity-50">
                  {busy ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
                  {t('repoSets.ship.retry')}
                </button>
              )}
              <button type="button" onClick={close} disabled={busy} className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/90 disabled:opacity-50">
                {t('common.close')}
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={close} disabled={busy} className="rounded border border-border px-3 py-1.5 text-xs text-muted hover:bg-surface-hover hover:text-primary disabled:opacity-50">
                {t('common.cancel')}
              </button>
              <button type="submit" disabled={busy} className="flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/90 disabled:opacity-50">
                {busy ? <Loader2 size={12} className="animate-spin" /> : <Rocket size={12} />}
                {busy ? t('repoSets.ship.shipping') : t('repoSets.ship.submit')}
              </button>
            </>
          )}
        </div>
      </form>
    </div>
  )
}
