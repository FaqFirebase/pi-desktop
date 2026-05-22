import { AlertCircle, CheckCircle2, FileSearch, GitCompare, ShieldCheck } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../store'
import { PermissionSelector } from './permission-selector'
import type { GitFileStatus } from '../../../shared/ipc-contracts'

interface ChangedFile {
  path: string
  status: GitFileStatus
}

export function ReviewRail(): React.JSX.Element {
  const settings = useAppStore((state) => state.settings)
  const setPermissionMode = useAppStore((state) => state.setPermissionMode)
  const pendingSteering = useAppStore((state) => state.pendingSteering)
  const pendingFollowUp = useAppStore((state) => state.pendingFollowUp)
  const setCurrentView = useAppStore((state) => state.setCurrentView)
  const isStreaming = useAppStore((state) => state.isStreaming)
  const activeWorkspace = useAppStore((state) => state.activeWorkspace)
  const messages = useAppStore((state) => state.messages)
  const [gitStatus, setGitStatus] = useState<Record<string, GitFileStatus>>({})

  const pendingCount = pendingSteering.length + pendingFollowUp.length
  const changedFiles = useMemo<ChangedFile[]>(
    () => Object.entries(gitStatus)
      .map(([path, status]) => ({ path, status }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    [gitStatus]
  )

  useEffect(() => {
    let cancelled = false

    const loadStatus = async () => {
      try {
        const status = await window.piDesktop.files.getGitStatus()
        if (!cancelled) setGitStatus(status)
      } catch {
        if (!cancelled) setGitStatus({})
      }
    }

    loadStatus()
    const interval = window.setInterval(loadStatus, 5000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [activeWorkspace?.id, messages.length, isStreaming])

  return (
    <aside className="hidden w-80 shrink-0 flex-col border-l border-neutral-800 bg-neutral-950 xl:flex">
      <div className="border-b border-neutral-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <ShieldCheck size={16} className="text-emerald-400" />
          <h2 className="text-sm font-semibold text-neutral-100">Review</h2>
        </div>
        <p className="mt-1 text-xs leading-5 text-neutral-500">
          Control what PI can do before changes move forward.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        <section>
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-500">
            Permissions
          </div>
          <PermissionSelector
            value={settings?.permissionMode}
            onChange={setPermissionMode}
          />
        </section>

        <section className="mt-6">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-xs font-medium uppercase tracking-wide text-neutral-500">
              Pending Approvals
            </div>
            <span className="rounded-full bg-neutral-800 px-2 py-0.5 text-[10px] text-neutral-400">
              {pendingCount}
            </span>
          </div>
          <div className="rounded-md border border-neutral-800 bg-neutral-900/50 p-3">
            {pendingCount > 0 ? (
              <div className="flex items-start gap-2 text-sm text-yellow-300">
                <AlertCircle size={15} className="mt-0.5 shrink-0" />
                <span>{pendingCount} queued item{pendingCount === 1 ? '' : 's'} waiting for the active session.</span>
              </div>
            ) : (
              <div className="flex items-start gap-2 text-sm text-neutral-400">
                <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-emerald-400" />
                <span>No approval requests waiting.</span>
              </div>
            )}
          </div>
        </section>

        <section className="mt-6">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-xs font-medium uppercase tracking-wide text-neutral-500">
              Changed Files
            </div>
            <span className="rounded-full bg-neutral-800 px-2 py-0.5 text-[10px] text-neutral-400">
              {changedFiles.length}
            </span>
          </div>
          <div className="mb-2 overflow-hidden rounded-md border border-neutral-800 bg-neutral-900/50">
            {changedFiles.length === 0 ? (
              <div className="px-3 py-3 text-sm text-neutral-500">No working tree changes.</div>
            ) : (
              <div className="max-h-44 overflow-y-auto py-1">
                {changedFiles.slice(0, 8).map((file) => (
                  <button
                    key={file.path}
                    type="button"
                    onClick={() => setCurrentView('diff')}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-neutral-300 transition-colors hover:bg-neutral-800"
                    title={file.path}
                  >
                    <span className="shrink-0 rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[10px] text-neutral-400">
                      {formatGitStatus(file.status)}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{file.path}</span>
                  </button>
                ))}
                {changedFiles.length > 8 && (
                  <div className="px-3 py-1.5 text-xs text-neutral-500">
                    +{changedFiles.length - 8} more
                  </div>
                )}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => setCurrentView('diff')}
            className="flex w-full items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900/50 px-3 py-2 text-left text-sm text-neutral-300 transition-colors hover:border-neutral-700 hover:bg-neutral-900"
          >
            <GitCompare size={15} className="shrink-0 text-neutral-500" />
            <span className="min-w-0 flex-1">
              <span className="block">Open diff review</span>
              <span className="mt-0.5 block text-xs text-neutral-500">
                Inspect working tree changes.
              </span>
            </span>
          </button>
        </section>

        <section className="mt-6">
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-500">
            Session Status
          </div>
          <div className="rounded-md border border-neutral-800 bg-neutral-900/50 p-3 text-sm text-neutral-400">
            <div className="flex items-center gap-2">
              <FileSearch size={15} className="text-neutral-500" />
              <span>{isStreaming ? 'PI is working in the active session.' : 'PI is idle in the active session.'}</span>
            </div>
          </div>
        </section>
      </div>
    </aside>
  )
}

function formatGitStatus(status: GitFileStatus): string {
  if (status.index === '?' && status.worktree === '?') return 'NEW'
  if (status.index === 'D' || status.worktree === 'D') return 'DEL'
  if (status.index === 'A') return 'ADD'
  if (status.index === 'R') return 'REN'
  if (status.index === 'M' || status.worktree === 'M') return status.isStaged ? 'STG' : 'MOD'
  return 'CHG'
}
