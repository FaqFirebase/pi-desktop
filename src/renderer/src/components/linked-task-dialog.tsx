import { useCallback, useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Boxes, FolderGit2, GitBranch, Pencil, Play, Plus, Trash2, X } from 'lucide-react'
import { clsx } from 'clsx'
import { useAppStore, type LinkedTaskDialogView } from '../store'
import type { LinkedTaskMode, RepoSet, RepoSetMember } from '../../../shared/ipc-contracts'
import {
  addRepoSetMember,
  describeRepoSetDraftProblem,
  removeRepoSetMember,
  renameRepoSetMember,
  repoSetDraftProblem,
  setMainRepoSetMember,
} from '../../../shared/repo-set-draft'
import { pathsEqual } from '../../../shared/path-compare'
import { formatIpcError } from '../utils/ipc-error'

const FIELD = 'w-full rounded-md border border-border bg-app px-3 py-2 text-sm text-primary outline-none placeholder:text-faint focus:border-focus'
const SECONDARY_BUTTON = 'rounded-md px-3 py-1.5 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-primary disabled:opacity-50'
const PRIMARY_BUTTON = 'flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50'
const MODES: readonly LinkedTaskMode[] = ['isolated', 'inPlace']

/**
 * Linked tasks: one task across the git repositories of a saved repo set.
 * The start view picks a set and how the agent works in it; the edit view
 * makes or changes a set. The `/linked-task` and `/new-repo-set` commands
 * open the same views.
 */
export function LinkedTaskDialog(): React.JSX.Element | null {
  const view = useAppStore((state) => state.linkedTaskDialog)
  const setView = useAppStore((state) => state.setLinkedTaskDialog)
  const titleId = useId()
  const [sets, setSets] = useState<RepoSet[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const open = view !== null

  const reload = useCallback(async (): Promise<void> => {
    try {
      setSets(await window.piDesktop.repoSets.list())
      setLoadError(null)
    } catch (error) {
      setLoadError(formatIpcError(error))
    }
  }, [])

  useEffect(() => {
    if (open) void reload()
    else setSets(null)
  }, [open, reload])

  if (!view) return null
  const close = (): void => setView(null)

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 px-4 pt-[10vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
      role="presentation"
    >
      <section
        className="flex max-h-[80vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-border-strong bg-surface shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        {view.view === 'start' ? (
          <StartView
            titleId={titleId}
            sets={sets}
            loadError={loadError}
            initialSetId={view.setId}
            onEdit={(setId) => setView({ view: 'edit', setId })}
            onClose={close}
          />
        ) : (
          <EditView
            key={view.setId ?? 'new'}
            titleId={titleId}
            set={view.setId ? sets?.find((item) => item.id === view.setId) ?? null : null}
            loading={view.setId !== null && sets === null}
            onDone={async (next: LinkedTaskDialogView) => {
              await reload()
              setView(next)
            }}
            onClose={close}
          />
        )}
      </section>
    </div>
  )
}

function DialogHeader({ titleId, title, subtitle, onClose, closeDisabled }: {
  titleId: string
  title: string
  subtitle?: string
  onClose: () => void
  closeDisabled?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex items-start justify-between border-b border-border px-5 py-4">
      <div>
        <div className="flex items-center gap-2">
          <Boxes size={16} className="text-accent-fg" />
          <h2 id={titleId} className="text-sm font-semibold text-primary">{title}</h2>
        </div>
        {subtitle && <p className="mt-1 text-xs text-dim">{subtitle}</p>}
      </div>
      <button
        type="button"
        onClick={onClose}
        disabled={closeDisabled}
        className="rounded p-1 text-faint transition-colors hover:bg-surface-hover hover:text-primary disabled:opacity-50"
        aria-label={t('repoSets.dialog.closeAriaLabel')}
      >
        <X size={15} />
      </button>
    </div>
  )
}

function ErrorLine({ text }: { text: string | null }): React.JSX.Element | null {
  if (!text) return null
  return <p role="alert" className="whitespace-pre-wrap break-words rounded-md border border-error/20 bg-error-bg px-3 py-2 text-xs text-error">{text}</p>
}

function StartView({ titleId, sets, loadError, initialSetId, onEdit, onClose }: {
  titleId: string
  sets: RepoSet[] | null
  loadError: string | null
  initialSetId?: string
  onEdit: (setId: string | null) => void
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const createLinkedTaskTab = useAppStore((state) => state.createLinkedTaskTab)
  const [setId, setSetId] = useState(initialSetId ?? '')
  const [name, setName] = useState('')
  const [mode, setMode] = useState<LinkedTaskMode>('isolated')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const selected = sets?.find((item) => item.id === setId) ?? sets?.[0] ?? null

  useEffect(() => {
    if (sets && !sets.some((item) => item.id === setId)) setSetId(sets[0]?.id ?? '')
  }, [sets, setId])

  const close = (): void => {
    if (!busy) onClose()
  }

  const submit = async (): Promise<void> => {
    if (!selected || busy) return
    setBusy(true)
    setError(null)
    try {
      const started = await createLinkedTaskTab({ setId: selected.id, mode, ...(name.trim() ? { name: name.trim() } : {}) })
      if (started) onClose()
    } catch (err) {
      setError(formatIpcError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <DialogHeader titleId={titleId} title={t('repoSets.start.title')} subtitle={t('repoSets.start.subtitle')} onClose={close} closeDisabled={busy} />
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        <ErrorLine text={loadError} />
        <fieldset className="min-w-0">
          <legend className="mb-1.5 block text-xs font-medium text-secondary">{t('repoSets.start.setLabel')}</legend>
          {sets?.length === 0 && <p className="text-xs text-dim">{t('repoSets.start.empty')}</p>}
          <ul className="space-y-1.5">
            {sets?.map((set) => (
              <li key={set.id} className={clsx(
                'flex items-start gap-2 rounded-md border px-3 py-2.5',
                selected?.id === set.id ? 'border-accent/60 bg-accent-bg/20' : 'border-border bg-app/50 hover:bg-surface-hover/60',
              )}>
                <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2">
                  <input
                    type="radio"
                    name="repo-set"
                    checked={selected?.id === set.id}
                    onChange={() => setSetId(set.id)}
                    disabled={busy}
                    className="mt-0.5 accent-[var(--accent)]"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-medium text-secondary">{set.name}</span>
                    <span className="mt-0.5 block truncate text-[11px] text-faint" title={set.members.map((member) => member.sourcePath).join('\n')}>
                      {t('repoSets.start.repositoryCount', { count: set.members.length })}
                      {' · '}
                      {set.members.map((member) => member.name).join(', ')}
                    </span>
                  </span>
                </label>
                <button
                  type="button"
                  onClick={() => onEdit(set.id)}
                  disabled={busy}
                  className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-faint transition-colors hover:bg-surface-hover hover:text-primary"
                  aria-label={t('repoSets.start.editSetAriaLabel', { name: set.name })}
                >
                  <Pencil size={11} aria-hidden="true" />
                  {t('repoSets.start.editSet')}
                </button>
              </li>
            ))}
          </ul>
        </fieldset>

        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-secondary">{t('repoSets.start.nameLabel')}</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={selected ? selected.name : t('repoSets.start.namePlaceholder')}
            disabled={busy}
            className={FIELD}
          />
        </label>

        <fieldset className="min-w-0">
          <legend className="mb-1.5 block text-xs font-medium text-secondary">{t('repoSets.start.modeLabel')}</legend>
          <div className="space-y-1.5">
            {MODES.map((option) => (
              <label key={option} className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-app/50 px-3 py-2.5">
                <input
                  type="radio"
                  name="linked-task-mode"
                  checked={mode === option}
                  onChange={() => setMode(option)}
                  disabled={busy}
                  className="mt-0.5 accent-[var(--accent)]"
                />
                <span className="flex min-w-0 items-start gap-2">
                  {option === 'isolated'
                    ? <GitBranch size={14} className="mt-0.5 shrink-0 text-special" />
                    : <FolderGit2 size={14} className="mt-0.5 shrink-0 text-muted" />}
                  <span>
                    <span className="block text-xs font-medium text-secondary">
                      {option === 'isolated' ? t('repoSets.mode.isolated.label') : t('repoSets.mode.inPlace.label')}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-faint">
                      {option === 'isolated' ? t('repoSets.mode.isolated.description') : t('repoSets.mode.inPlace.description')}
                    </span>
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <ErrorLine text={error} />
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-border bg-app/40 px-5 py-3">
        <button type="button" onClick={() => onEdit(null)} disabled={busy} className={clsx(SECONDARY_BUTTON, 'flex items-center gap-1.5')}>
          <Plus size={12} />
          {t('repoSets.start.newSet')}
        </button>
        <div className="flex items-center gap-2">
          <button type="button" onClick={close} disabled={busy} className={SECONDARY_BUTTON}>{t('common.cancel')}</button>
          <button type="button" onClick={() => void submit()} disabled={busy || !selected} className={PRIMARY_BUTTON}>
            <Play size={12} />
            {busy ? t('repoSets.start.starting') : t('repoSets.start.submit')}
          </button>
        </div>
      </div>
    </>
  )
}

function EditView({ titleId, set, loading, onDone, onClose }: {
  titleId: string
  set: RepoSet | null
  loading: boolean
  onDone: (next: LinkedTaskDialogView) => Promise<void>
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const requestConfirm = useAppStore((state) => state.requestConfirm)
  const [name, setName] = useState(set?.name ?? '')
  const [members, setMembers] = useState<RepoSetMember[]>(set?.members ?? [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const problem = repoSetDraftProblem(name, members)

  // The set list arrives after the view opens on an existing set.
  useEffect(() => {
    if (!set) return
    setName(set.name)
    setMembers(set.members)
  }, [set])

  const close = (): void => {
    if (!busy) onClose()
  }

  const addRepository = async (): Promise<void> => {
    setError(null)
    const path = await window.piDesktop.system.openDialog({ title: t('repoSets.edit.pickFolderTitle') })
    if (!path) return
    try {
      const folder = await window.piDesktop.repoSets.inspectFolder(path)
      if (members.some((member) => pathsEqual(member.sourcePath, folder.path))) {
        setError(t('repoSets.errors.duplicateFolder', { path: folder.path }))
        return
      }
      setMembers((current) => addRepoSetMember(current, folder))
    } catch (err) {
      setError(formatIpcError(err))
    }
  }

  const save = async (): Promise<void> => {
    if (problem || busy) return
    setBusy(true)
    setError(null)
    try {
      const saved = await window.piDesktop.repoSets.save({ ...(set ? { id: set.id } : {}), name, members })
      await onDone({ view: 'start', setId: saved.id })
    } catch (err) {
      setError(formatIpcError(err))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!set || busy) return
    const confirmed = await requestConfirm({
      title: t('repoSets.edit.deleteConfirmTitle'),
      message: t('repoSets.edit.deleteConfirmMessage', { name: set.name }),
      confirmLabel: t('common.delete'),
      cancelLabel: t('common.cancel'),
      danger: true,
    })
    if (!confirmed) return
    setBusy(true)
    try {
      await window.piDesktop.repoSets.delete(set.id)
      await onDone({ view: 'start' })
    } catch (err) {
      setError(formatIpcError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <DialogHeader
        titleId={titleId}
        title={set ? t('repoSets.edit.editTitle') : t('repoSets.edit.newTitle')}
        subtitle={t('repoSets.edit.hint')}
        onClose={close}
        closeDisabled={busy}
      />
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-secondary">{t('repoSets.edit.nameLabel')}</span>
          <input autoFocus value={name} onChange={(event) => setName(event.target.value)} disabled={busy || loading} className={FIELD} />
        </label>

        <fieldset className="min-w-0">
          <legend className="mb-1.5 block text-xs font-medium text-secondary">{t('repoSets.edit.repositoriesLabel')}</legend>
          <ul className="space-y-1.5">
            {members.map((member, index) => (
              <li key={member.sourcePath} className="flex items-center gap-2 rounded-md border border-border bg-app/50 px-2.5 py-2">
                <label className="flex shrink-0 items-center gap-1 text-[11px] text-faint" title={t('repoSets.edit.mainTitle')}>
                  <input
                    type="radio"
                    name="main-repository"
                    checked={member.role === 'main'}
                    onChange={() => setMembers((current) => setMainRepoSetMember(current, index))}
                    disabled={busy}
                    className="accent-[var(--accent)]"
                  />
                  {t('repoSets.edit.mainLabel')}
                </label>
                <span className="min-w-0 flex-1">
                  <input
                    value={member.name}
                    onChange={(event) => setMembers((current) => renameRepoSetMember(current, index, event.target.value))}
                    disabled={busy}
                    aria-label={t('repoSets.edit.repositoryNameAriaLabel')}
                    className="w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-xs font-medium text-secondary outline-none hover:border-border focus:border-focus"
                  />
                  <span className="block truncate px-1 font-mono text-[10px] text-faint" title={member.sourcePath}>{member.sourcePath}</span>
                </span>
                <button
                  type="button"
                  onClick={() => setMembers((current) => removeRepoSetMember(current, index))}
                  disabled={busy}
                  className="shrink-0 rounded p-1 text-faint transition-colors hover:bg-surface-hover hover:text-primary"
                  aria-label={t('repoSets.edit.removeRepositoryAriaLabel', { name: member.name })}
                  title={t('repoSets.edit.removeRepositoryAriaLabel', { name: member.name })}
                >
                  <X size={12} />
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => void addRepository()}
            disabled={busy || loading}
            className="mt-2 flex items-center gap-1.5 rounded-md border border-dashed border-border-strong px-3 py-1.5 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-primary disabled:opacity-50"
          >
            <Plus size={12} />
            {t('repoSets.edit.addRepository')}
          </button>
        </fieldset>
        {problem && members.length > 0 && <p className="text-[11px] text-faint" role="status">{describeRepoSetDraftProblem(problem)}</p>}
        <ErrorLine text={error} />
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-border bg-app/40 px-5 py-3">
        <div>
          {set && (
            <button type="button" onClick={() => void remove()} disabled={busy} className={clsx(SECONDARY_BUTTON, 'flex items-center gap-1.5 hover:text-error')}>
              <Trash2 size={12} />
              {t('repoSets.edit.delete')}
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => void onDone({ view: 'start', ...(set ? { setId: set.id } : {}) })} disabled={busy} className={SECONDARY_BUTTON}>
            {t('repoSets.edit.back')}
          </button>
          <button type="button" onClick={() => void save()} disabled={busy || loading || problem !== null} className={PRIMARY_BUTTON}>
            {t('common.save')}
          </button>
        </div>
      </div>
    </>
  )
}
