import { useEffect, useMemo, useState } from 'react'
import { clsx } from 'clsx'
import {
  SquareTerminal,
  FolderOpen,
  Plus,
  Clock,
  Layers,
  GitCompare,
  AlertTriangle,
  Settings as SettingsIcon,
} from 'lucide-react'
import { useAppStore } from '../store'
import { formatGitStatus } from './review-rail'
import type { GitFileStatus, SessionListItem } from '../../../shared/ipc-contracts'

const MAX_RECENT_WORKSPACES = 6
const MAX_RECENT_SESSIONS = 5
const MAX_CHANGED_FILES = 8

/**
 * Home / launcher screen shown on startup (when openToHomeOnLaunch is set).
 * Pi is not running yet — every action here starts Pi lazily for the chosen
 * workspace/session, then navigates to Chat. All data shown is Pi-free
 * (workspaces, disk-listed sessions, git status for the active workspace).
 */
export function HomeScreen(): React.JSX.Element {
  const workspaces = useAppStore((s) => s.workspaces)
  const activeWorkspace = useAppStore((s) => s.activeWorkspace)
  const sessionList = useAppStore((s) => s.sessionList)
  const archivedSessions = useAppStore((s) => s.archivedSessions)
  const piStatus = useAppStore((s) => s.piStatus)
  const piError = useAppStore((s) => s.piError)
  const switchWorkspace = useAppStore((s) => s.switchWorkspace)
  const createWorkspace = useAppStore((s) => s.createWorkspace)
  const switchSession = useAppStore((s) => s.switchSession)
  const createNewSession = useAppStore((s) => s.createNewSession)
  const startPi = useAppStore((s) => s.startPi)
  const setCurrentView = useAppStore((s) => s.setCurrentView)

  const [version, setVersion] = useState('')
  const [gitStatus, setGitStatus] = useState<Record<string, GitFileStatus>>({})
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    window.piDesktop.system.getVersion().then(setVersion).catch(() => setVersion(''))
  }, [])

  // Git status for the active (most-recent) workspace — works without Pi.
  useEffect(() => {
    let cancelled = false
    window.piDesktop.files
      .getGitStatus()
      .then((s) => { if (!cancelled) setGitStatus(s) })
      .catch(() => { if (!cancelled) setGitStatus({}) })
    return () => { cancelled = true }
  }, [activeWorkspace?.id])

  const recentWorkspaces = useMemo(
    () => [...workspaces].sort((a, b) => b.lastActiveAt - a.lastActiveAt).slice(0, MAX_RECENT_WORKSPACES),
    [workspaces]
  )
  // Exclude archived sessions and cap the list so Home stays uncluttered.
  const recentSessions = useMemo(
    () => sessionList.filter((s) => !(s.sessionId in archivedSessions)).slice(0, MAX_RECENT_SESSIONS),
    [sessionList, archivedSessions]
  )
  const changedFiles = useMemo(
    () => Object.entries(gitStatus)
      .map(([path, status]) => ({ path, status }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    [gitStatus]
  )

  // Navigate to Chat unless Pi failed to start (then stay so the error shows).
  const goChatUnlessError = (): void => {
    if (useAppStore.getState().piStatus !== 'error') setCurrentView('chat')
  }

  const openWorkspace = async (workspaceId: string): Promise<void> => {
    setBusy(true)
    try {
      await switchWorkspace(workspaceId)
      goChatUnlessError()
    } finally {
      setBusy(false)
    }
  }

  const openFolder = async (): Promise<void> => {
    const path = await window.piDesktop.system.openDialog({ title: 'Open Folder' })
    if (!path) return
    setBusy(true)
    try {
      let ws = useAppStore.getState().workspaces.find((w) => w.path === path)
      if (!ws) {
        // Cross-platform basename: split on both POSIX and Windows separators.
        const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path
        await createWorkspace(name, path)
        ws = useAppStore.getState().workspaces.find((w) => w.path === path)
      }
      if (ws) {
        await switchWorkspace(ws.id)
        goChatUnlessError()
      }
    } finally {
      setBusy(false)
    }
  }

  const openSession = async (session: SessionListItem): Promise<void> => {
    setBusy(true)
    try {
      let targetId: string | undefined
      if (session.projectPath) {
        let ws = useAppStore.getState().workspaces.find((w) => w.path === session.projectPath)
        if (!ws) {
          await createWorkspace(session.projectName, session.projectPath)
          ws = useAppStore.getState().workspaces.find((w) => w.path === session.projectPath)
        }
        targetId = ws?.id
      }
      if (targetId) await switchWorkspace(targetId)
      else await startPi()
      if (useAppStore.getState().piStatus === 'error') return
      await switchSession(session.path)
      setCurrentView('chat')
    } finally {
      setBusy(false)
    }
  }

  const newSession = async (): Promise<void> => {
    if (!activeWorkspace) {
      await openFolder()
      return
    }
    setBusy(true)
    try {
      await switchWorkspace(activeWorkspace.id)
      if (useAppStore.getState().piStatus === 'error') return
      await createNewSession()
      setCurrentView('chat')
    } finally {
      setBusy(false)
    }
  }

  const openChangedFiles = async (): Promise<void> => {
    if (!activeWorkspace) return
    setBusy(true)
    try {
      await switchWorkspace(activeWorkspace.id)
      if (useAppStore.getState().piStatus !== 'error') setCurrentView('diff')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className={clsx('mx-auto max-w-4xl px-8 py-12', busy && 'pointer-events-none opacity-60')}>
        {/* Pi-not-found / start error */}
        {piStatus === 'error' && piError && (
          <div className="mb-6 flex items-start gap-3 rounded-lg border border-red-900/50 bg-red-950/30 px-4 py-3 text-sm text-red-300">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <div className="flex-1">
              <div className="font-medium">Couldn&apos;t start Pi</div>
              <div className="mt-0.5 text-red-300/80">{piError}</div>
              <div className="mt-1 text-xs text-red-300/70">
                Check that Pi is installed and its path is correct.
              </div>
            </div>
            <button
              onClick={() => setCurrentView('settings')}
              className="flex shrink-0 items-center gap-1.5 rounded-md bg-red-900/40 px-2.5 py-1 text-xs text-red-200 hover:bg-red-900/60"
            >
              <SettingsIcon size={12} />
              Settings
            </button>
          </div>
        )}

        {/* Header */}
        <div className="mb-10 flex flex-col items-center text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-neutral-800 text-blue-400">
            <SquareTerminal size={34} />
          </div>
          <h1 className="mt-4 text-2xl font-semibold text-neutral-100">Pi Desktop</h1>
          <p className="mt-1 text-sm text-neutral-500">Open a workspace or pick up where you left off.</p>
          {version && <p className="mt-2 text-xs text-neutral-600">v{version}</p>}
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          {/* Actions */}
          <section className="space-y-3">
            <SectionLabel>Open</SectionLabel>
            <button
              onClick={openFolder}
              className="flex w-full items-center gap-3 rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-3 text-left transition-colors hover:border-neutral-600 hover:bg-neutral-800"
            >
              <FolderOpen size={18} className="shrink-0 text-blue-400" />
              <div className="min-w-0">
                <div className="text-sm font-medium text-neutral-200">Open Folder</div>
                <div className="text-xs text-neutral-500">Browse for a project to open as a workspace</div>
              </div>
            </button>
            <button
              onClick={newSession}
              className="flex w-full items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-900/50 px-4 py-3 text-left transition-colors hover:border-neutral-700 hover:bg-neutral-800/60"
            >
              <Plus size={18} className="shrink-0 text-neutral-400" />
              <div className="min-w-0">
                <div className="text-sm font-medium text-neutral-200">New Session</div>
                <div className="truncate text-xs text-neutral-500">
                  {activeWorkspace ? `In ${activeWorkspace.name}` : 'Pick a folder first'}
                </div>
              </div>
            </button>

            {/* Changed files for the most-recent workspace */}
            <div className="rounded-lg border border-neutral-800 bg-neutral-900/50">
              <div className="flex items-center justify-between px-4 py-2.5">
                <SectionLabel className="mb-0">Changed Files</SectionLabel>
                <span className="rounded-full bg-neutral-800 px-2 py-0.5 text-[10px] text-neutral-400">
                  {changedFiles.length}
                </span>
              </div>
              {changedFiles.length === 0 ? (
                <div className="px-4 pb-3 text-xs text-neutral-600">
                  {activeWorkspace ? 'No working tree changes.' : 'No workspace selected.'}
                </div>
              ) : (
                <div className="max-h-40 overflow-y-auto border-t border-neutral-800/60 py-1">
                  {changedFiles.slice(0, MAX_CHANGED_FILES).map((file) => (
                    <button
                      key={file.path}
                      onClick={openChangedFiles}
                      title={file.path}
                      className="flex w-full items-center gap-2 px-4 py-1.5 text-left text-xs text-neutral-300 transition-colors hover:bg-neutral-800"
                    >
                      <span className="shrink-0 rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[10px] text-neutral-400">
                        {formatGitStatus(file.status)}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{file.path}</span>
                    </button>
                  ))}
                  {changedFiles.length > MAX_CHANGED_FILES && (
                    <button
                      onClick={openChangedFiles}
                      className="flex w-full items-center gap-1.5 px-4 py-1.5 text-xs text-neutral-500 hover:text-neutral-300"
                    >
                      <GitCompare size={11} />
                      +{changedFiles.length - MAX_CHANGED_FILES} more — open diff review
                    </button>
                  )}
                </div>
              )}
            </div>
          </section>

          {/* Recent */}
          <section className="space-y-6">
            <div>
              <SectionLabel>Recent Workspaces</SectionLabel>
              <div className="space-y-1.5">
                {recentWorkspaces.length === 0 ? (
                  <EmptyHint>No workspaces yet.</EmptyHint>
                ) : (
                  recentWorkspaces.map((ws) => (
                    <button
                      key={ws.id}
                      onClick={() => openWorkspace(ws.id)}
                      className="group flex w-full items-center gap-3 rounded-md border border-neutral-800 bg-neutral-900/40 px-3 py-2 text-left transition-colors hover:border-neutral-700 hover:bg-neutral-800/60"
                    >
                      <Layers size={14} className="shrink-0" style={{ color: ws.color }} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm text-neutral-200">{ws.name}</div>
                        <div className="truncate text-[11px] text-neutral-600">{ws.path}</div>
                      </div>
                      {ws.id === activeWorkspace?.id && (
                        <span className="shrink-0 rounded bg-blue-900/40 px-1.5 py-0.5 text-[10px] text-blue-400">
                          last
                        </span>
                      )}
                    </button>
                  ))
                )}
              </div>
            </div>

            <div>
              <SectionLabel>Recent Sessions</SectionLabel>
              <div className="space-y-1.5">
                {recentSessions.length === 0 ? (
                  <EmptyHint>No sessions yet.</EmptyHint>
                ) : (
                  recentSessions.map((session) => (
                    <button
                      key={session.path}
                      onClick={() => openSession(session)}
                      className="flex w-full items-center gap-3 rounded-md border border-neutral-800 bg-neutral-900/40 px-3 py-2 text-left transition-colors hover:border-neutral-700 hover:bg-neutral-800/60"
                    >
                      <Clock size={13} className="shrink-0 text-neutral-600" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm text-neutral-300">
                          {session.name || session.sessionId.slice(0, 12)}
                        </div>
                        <div className="truncate text-[11px] text-neutral-600">{session.projectName}</div>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

function SectionLabel({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div className={clsx('mb-2 text-xs font-medium uppercase tracking-wide text-neutral-500', className)}>
      {children}
    </div>
  )
}

function EmptyHint({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="rounded-md border border-neutral-800 bg-neutral-900/40 px-3 py-2 text-xs text-neutral-600">{children}</div>
}
