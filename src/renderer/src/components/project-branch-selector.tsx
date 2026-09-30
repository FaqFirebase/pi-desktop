import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { GitBranch, Loader2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { t } from '../../../shared/i18n'
import type { GitConveyorStatus } from '../../../shared/ipc-contracts'
import { useAppStore } from '../store'
import { withGitOperation } from '../utils/git-operation'
import { formatIpcError } from '../utils/ipc-error'
import { createStaleGuard } from '../utils/stale-guard'
import { isImeComposing } from '../utils/ime-composing'

/**
 * Value of the "New branch" item in the branch menu. A colon can never be part
 * of a Git branch name, so it cannot collide with a real branch.
 */
export const NEW_BRANCH_OPTION_VALUE = ':new-branch'

/**
 * Create a branch from the current HEAD on the workspace the user is looking
 * at and switch to it. Unsaved editor text and uncommitted changes stay as
 * they are: the files do not change.
 */
export async function createProjectBranch(workspaceId: string, name: string): Promise<GitConveyorStatus> {
  const branch = name.trim()
  if (!branch) throw new Error(t('conveyor.branches.nameRequired'))
  return withGitOperation(async () => {
    if (useAppStore.getState().activeWorkspace?.id !== workspaceId) {
      throw new Error(t('conveyor.errors.workspaceChanged'))
    }
    const result = await window.piDesktop.git.createBranch(workspaceId, branch)
    if (!result.ok) throw new Error(result.error)
    return result.status
  })
}

export async function switchProjectBranch(workspaceId: string, branch: string): Promise<GitConveyorStatus | null> {
  const assertWorkspace = (): void => {
    if (useAppStore.getState().activeWorkspace?.id !== workspaceId) {
      throw new Error(t('conveyor.errors.workspaceChanged'))
    }
  }
  return withGitOperation(async () => {
    assertWorkspace()
    const state = useAppStore.getState()
    if (state.editorDirty) throw new Error(t('conveyor.branches.saveEditor'))
    if (state.previewTarget && !(await state.setPreviewTarget(null))) return null
    assertWorkspace()
    if (useAppStore.getState().editorDirty) throw new Error(t('conveyor.branches.saveEditor'))
    const result = await window.piDesktop.git.switchBranch(workspaceId, branch)
    if (!result.ok) throw new Error(result.error)
    return result.status
  })
}

export function ProjectBranchSelector({ workspaceId }: { workspaceId: string }): React.JSX.Element | null {
  const { t } = useTranslation()
  const [repository, setRepository] = useState<{ branch: string | null; head: string; branches: string[] } | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const mounted = useRef(false)
  const guard = useRef(createStaleGuard())
  const [loadError, setLoadError] = useState<string | null>(null)
  const [switchError, setSwitchError] = useState<string | null>(null)
  const error = switchError ?? loadError
  /** The inline "New branch" form: the typed name and the last refusal. */
  const [newBranch, setNewBranch] = useState<{ name: string; error: string | null } | null>(null)
  const newBranchInputId = useId()

  const sameWorkspace = useCallback((): boolean =>
    mounted.current && useAppStore.getState().activeWorkspace?.id === workspaceId, [workspaceId])

  const refresh = useCallback(async (): Promise<void> => {
    const isCurrent = guard.current.begin()
    setLoading(true)
    try {
      const [status, branches] = await Promise.all([
        window.piDesktop.git.status(),
        window.piDesktop.git.localBranches(),
      ])
      if (!isCurrent() || !sameWorkspace()) return
      setRepository({ branch: status.branch, head: status.head, branches })
      setLoadError(null)
    } catch (err) {
      if (isCurrent() && sameWorkspace()) setLoadError(formatIpcError(err))
    } finally {
      if (isCurrent() && sameWorkspace()) setLoading(false)
    }
  }, [sameWorkspace])

  useEffect(() => {
    mounted.current = true
    const load = (): void => { void refresh() }
    load()
    window.addEventListener('focus', load)
    const unsubscribe = window.piDesktop.onFileChange(load)
    const requests = guard.current
    return () => {
      mounted.current = false
      requests.begin()
      unsubscribe()
      window.removeEventListener('focus', load)
    }
  }, [refresh])

  const createBranch = async (): Promise<void> => {
    if (busyRef.current || !newBranch) return
    busyRef.current = true
    setBusy(true)
    setSwitchError(null)
    try {
      await createProjectBranch(workspaceId, newBranch.name)
      if (sameWorkspace()) setNewBranch(null)
    } catch (err) {
      if (sameWorkspace()) setNewBranch((current) => current && { ...current, error: formatIpcError(err) })
    } finally {
      if (sameWorkspace()) {
        await refresh()
        setBusy(false)
      }
      busyRef.current = false
    }
  }

  const switchBranch = async (branch: string): Promise<void> => {
    if (branch === NEW_BRANCH_OPTION_VALUE) {
      setSwitchError(null)
      setNewBranch({ name: '', error: null })
      return
    }
    if (busyRef.current || branch === repository?.branch) return
    busyRef.current = true
    setBusy(true)
    setSwitchError(null)
    try {
      await switchProjectBranch(workspaceId, branch)
    } catch (err) {
      if (sameWorkspace()) setSwitchError(formatIpcError(err))
    } finally {
      if (sameWorkspace()) {
        await refresh()
        setBusy(false)
      }
      busyRef.current = false
    }
  }

  // An unborn branch (a new or freshly cloned empty repository) has a name but no HEAD yet.
  const hasRepository = repository && (repository.branch !== null || repository.head !== '')
  if (!hasRepository && !error) return null

  return (
    <div className="relative flex min-w-0 items-center gap-1 text-dim">
      {hasRepository && (
        <label className="flex min-w-0 items-center gap-1" title={t('statusBar.gitBranch', { branch: repository.branch ?? t('conveyor.detachedBranch') })}>
          {busy ? <Loader2 size={11} className="animate-spin" /> : <GitBranch size={11} />}
          <select
            aria-label={t('conveyor.branches.label')}
            title={t('conveyor.branches.description')}
            value={repository.branch ?? ''}
            onChange={(event) => void switchBranch(event.target.value)}
            disabled={loading || busy || !!loadError}
            className="field-sizing-content max-w-48 rounded bg-app py-0.5 text-xs text-dim outline-none hover:text-secondary focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-50"
          >
            {!repository.branch && <option value="" disabled>{t('conveyor.detachedBranch')}</option>}
            {repository.branch && !repository.branches.includes(repository.branch) && <option value={repository.branch}>{repository.branch}</option>}
            {repository.branches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}
            <option value={NEW_BRANCH_OPTION_VALUE}>{t('conveyor.branches.newBranchOption')}</option>
          </select>
        </label>
      )}
      {newBranch && (
        <form
          aria-label={t('conveyor.branches.newBranchTitle')}
          className="absolute bottom-full left-0 z-50 mb-2 w-80 max-w-[80vw] rounded-lg border border-border-strong bg-surface p-3 text-xs shadow-lg"
          onSubmit={(event) => {
            event.preventDefault()
            void createBranch()
          }}
        >
          <label htmlFor={newBranchInputId} className="text-muted">{t('conveyor.branches.newBranchTitle')}</label>
          <input
            id={newBranchInputId}
            autoFocus
            value={newBranch.name}
            onChange={(event) => setNewBranch({ name: event.target.value, error: null })}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && !isImeComposing(event.nativeEvent)) {
                event.preventDefault()
                setNewBranch(null)
              }
            }}
            placeholder={t('conveyor.branches.newBranchPlaceholder')}
            spellCheck={false}
            className="mt-1 w-full rounded border border-border-strong bg-app px-2 py-1 font-mono text-xs text-primary outline-none focus:border-focus"
          />
          <p className="mt-1 text-[11px] text-faint">
            {t('conveyor.branches.newBranchHint', { branch: repository?.branch ?? t('conveyor.detachedBranch') })}
          </p>
          {newBranch.error && <p role="alert" className="mt-1 whitespace-pre-wrap break-words text-[11px] text-error">{newBranch.error}</p>}
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" onClick={() => setNewBranch(null)} className="rounded border border-border px-2 py-1 text-muted hover:bg-surface-hover hover:text-primary">
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={busy || !newBranch.name.trim()}
              className="rounded bg-accent px-2 py-1 font-medium text-white hover:bg-accent/90 disabled:cursor-default disabled:opacity-50 disabled:hover:bg-accent"
            >
              {t('conveyor.branches.createBranch')}
            </button>
          </div>
        </form>
      )}
      {error && (
        <div role="alert" className="absolute bottom-full left-0 z-50 mb-2 flex w-80 max-w-[80vw] items-start gap-2 rounded-lg border border-error/20 bg-surface p-3 text-xs text-error shadow-lg">
          <span className="max-h-48 min-w-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words">{error}</span>
          <button
            type="button"
            onClick={() => { setSwitchError(null); setLoadError(null) }}
            aria-label={t('common.dismiss')}
            className="shrink-0 rounded p-1 hover:bg-error-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <X size={12} />
          </button>
        </div>
      )}
    </div>
  )
}
