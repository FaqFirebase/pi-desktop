import { useEffect, useMemo, useState } from 'react'
import { getSessionTitle } from '../utils/session-title'
import { clsx } from 'clsx'
import {
  FolderOpen,
  Plus,
  Clock,
  Layers,
  GitCompare,
  AlertTriangle,
  Settings as SettingsIcon,
  Play,
} from 'lucide-react'
import { useAppStore } from '../store'
import piLogo from '../assets/pi-logo.svg'
import { formatGitStatus } from './review-rail'
import { StatsPanel } from './stats-panel'
import type { GitFileStatus, SessionListItem } from '../../../shared/ipc-contracts'
import { workspaceNameFromFolderPath } from '../../../shared/folder-drop'
import { pathsEqual } from '../../../shared/path-compare'

const MAX_RECENT_WORKSPACES = 6
const MAX_RECENT_SESSIONS = 5
const MAX_CHANGED_FILES = 8

/**
 * Home launcher — full splash panel (stats, recents, open folder / new session).
 * Chat-first launch (Open to Home off) uses the empty-chat center prompt instead.
 */
export function HomeScreen(): React.JSX.Element {
  return <HomeScreenInfo />
}

/**
 * Home body: activity stats, changed files, recent workspaces/sessions.
 */
export function HomeInfoSummary({ compact }: { compact?: boolean }): React.JSX.Element {
  const workspaces = useAppStore((s) => s.workspaces)
  const activeWorkspace = useAppStore((s) => s.activeWorkspace)
  const sessionList = useAppStore((s) => s.sessionList)
  const archivedSessions = useAppStore((s) => s.archivedSessions)
  const activateWorkspace = useAppStore((s) => s.activateWorkspace)
  const createWorkspace = useAppStore((s) => s.createWorkspace)
  const switchSession = useAppStore((s) => s.switchSession)
  const setCurrentView = useAppStore((s) => s.setCurrentView)
  const requestChatScrollToBottom = useAppStore((s) => s.requestChatScrollToBottom)

  const [gitStatus, setGitStatus] = useState<Record<string, GitFileStatus>>({})
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.piDesktop.files
      .getGitStatus()
      .then((s) => {
        if (!cancelled) setGitStatus(s)
      })
      .catch(() => {
        if (!cancelled) setGitStatus({})
      })
    return () => {
      cancelled = true
    }
  }, [activeWorkspace?.id])

  const recentWorkspaces = useMemo(
    () => [...workspaces].sort((a, b) => b.lastActiveAt - a.lastActiveAt).slice(0, MAX_RECENT_WORKSPACES),
    [workspaces]
  )
  const recentSessions = useMemo(
    () => sessionList.filter((s) => !(s.sessionId in archivedSessions)).slice(0, MAX_RECENT_SESSIONS),
    [sessionList, archivedSessions]
  )
  const changedFiles = useMemo(
    () =>
      Object.entries(gitStatus)
        .map(([path, status]) => ({ path, status }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    [gitStatus]
  )

  const openWorkspace = async (workspaceId: string): Promise<void> => {
    setBusy(true)
    try {
      if (!(await activateWorkspace(workspaceId))) return
      if (useAppStore.getState().piStatus !== 'error') {
        requestChatScrollToBottom()
        setCurrentView('chat')
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
        let ws = useAppStore.getState().workspaces.find((w) => pathsEqual(w.path, session.projectPath))
        if (!ws) {
          await createWorkspace(session.projectName, session.projectPath)
          ws = useAppStore.getState().workspaces.find((w) => pathsEqual(w.path, session.projectPath))
        }
        targetId = ws?.id
      }
      // Workspace/session activation is non-destructive; the target Pi runtime
      // hydrates in the background while Chat opens immediately.
      if (targetId) {
        if (!(await activateWorkspace(targetId, { start: false }))) return
      }
      if (useAppStore.getState().piStatus === 'error') return
      await switchSession(session.path, session.projectPath)
      requestChatScrollToBottom()
      setCurrentView('chat')
    } finally {
      setBusy(false)
    }
  }

  const openChangedFiles = async (): Promise<void> => {
    if (!activeWorkspace) return
    setBusy(true)
    try {
      if (!(await activateWorkspace(activeWorkspace.id))) return
      if (useAppStore.getState().piStatus !== 'error') setCurrentView('diff')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={clsx(busy && 'pointer-events-none opacity-60', compact && 'space-y-4')}>
      <StatsPanel />

      <div className="grid gap-6 md:grid-cols-2">
        <section className="space-y-3">
          <div className="rounded-lg border border-border bg-surface/50">
            <div className="flex items-center justify-between px-4 py-2.5">
              <SectionLabel className="mb-0">Changed Files</SectionLabel>
              <span className="rounded-full bg-card px-2 py-0.5 text-[10px] text-muted">
                {changedFiles.length}
              </span>
            </div>
            {changedFiles.length === 0 ? (
              <div className="px-4 pb-3 text-xs text-faint">
                {activeWorkspace ? 'No working tree changes.' : 'No workspace selected.'}
              </div>
            ) : (
              <div className="max-h-40 overflow-y-auto border-t border-border/60 py-1">
                {changedFiles.slice(0, MAX_CHANGED_FILES).map((file) => (
                  <button
                    key={file.path}
                    onClick={() => void openChangedFiles()}
                    title={file.path}
                    className="flex w-full items-center gap-2 px-4 py-1.5 text-left text-xs text-secondary transition-colors hover:bg-surface-hover"
                  >
                    <span className="shrink-0 rounded bg-card px-1.5 py-0.5 font-mono text-[10px] text-muted">
                      {formatGitStatus(file.status)}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{file.path}</span>
                  </button>
                ))}
                {changedFiles.length > MAX_CHANGED_FILES && (
                  <button
                    onClick={() => void openChangedFiles()}
                    className="flex w-full items-center gap-1.5 px-4 py-1.5 text-xs text-dim hover:text-secondary"
                  >
                    <GitCompare size={11} />
                    +{changedFiles.length - MAX_CHANGED_FILES} more — open diff review
                  </button>
                )}
              </div>
            )}
          </div>
        </section>

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
                    onClick={() => void openWorkspace(ws.id)}
                    className="group flex w-full items-center gap-3 rounded-md border border-border bg-surface/40 px-3 py-2 text-left transition-colors hover:border-border-strong hover:bg-surface-hover/60"
                  >
                    <Layers size={14} className="shrink-0" style={{ color: ws.color }} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-primary">{ws.name}</div>
                      <div className="truncate text-[11px] text-faint">{ws.path}</div>
                    </div>
                    {ws.id === activeWorkspace?.id && (
                      <span className="shrink-0 rounded bg-accent-bg px-1.5 py-0.5 text-[10px] text-accent-fg">
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
                    onClick={() => void openSession(session)}
                    className="flex w-full items-center gap-3 rounded-md border border-border bg-surface/40 px-3 py-2 text-left transition-colors hover:border-border-strong hover:bg-surface-hover/60"
                  >
                    <Clock size={13} className="shrink-0 text-faint" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-secondary">
                        {getSessionTitle(session.name, session.sessionId, session.preview)}
                      </div>
                      <div className="truncate text-[11px] text-faint">{session.projectName}</div>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}

function PiErrorBanner(): React.JSX.Element | null {
  const piStatus = useAppStore((s) => s.piStatus)
  const piError = useAppStore((s) => s.piError)
  const setCurrentView = useAppStore((s) => s.setCurrentView)
  if (piStatus !== 'error' || !piError) return null
  return (
    <div className="mb-6 flex items-start gap-3 rounded-lg border border-error-bg bg-error-bg px-4 py-3 text-sm text-error">
      <AlertTriangle size={16} className="mt-0.5 shrink-0" />
      <div className="flex-1">
        <div className="font-medium">Couldn&apos;t start Pi</div>
        <div className="mt-0.5 text-error/80">{piError}</div>
        <div className="mt-1 text-xs text-error/70">Check that Pi is installed and its path is correct.</div>
      </div>
      <button
        onClick={() => setCurrentView('settings')}
        className="flex shrink-0 items-center gap-1.5 rounded-md bg-error/25 px-2.5 py-1 text-xs text-error hover:bg-error/40"
      >
        <SettingsIcon size={12} />
        Settings
      </button>
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
    <div className={clsx('mb-2 text-xs font-medium uppercase tracking-wide text-dim', className)}>
      {children}
    </div>
  )
}

function EmptyHint({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="rounded-md border border-border bg-surface/40 px-3 py-2 text-xs text-faint">{children}</div>
  )
}

function HomeScreenInfo(): React.JSX.Element {
  const activeWorkspace = useAppStore((s) => s.activeWorkspace)
  const activateWorkspace = useAppStore((s) => s.activateWorkspace)
  const createWorkspace = useAppStore((s) => s.createWorkspace)
  const createNewSession = useAppStore((s) => s.createNewSession)
  const setTaskLauncherOpen = useAppStore((s) => s.setTaskLauncherOpen)
  const setCurrentView = useAppStore((s) => s.setCurrentView)
  const requestChatScrollToBottom = useAppStore((s) => s.requestChatScrollToBottom)
  const [busy, setBusy] = useState(false)

  const goChatUnlessError = (): void => {
    if (useAppStore.getState().piStatus !== 'error') {
      requestChatScrollToBottom()
      setCurrentView('chat')
    }
  }

  const openFolder = async (): Promise<void> => {
    const path = await window.piDesktop.system.openDialog({ title: 'Open Folder' })
    if (!path) return
    setBusy(true)
    try {
      let ws = useAppStore.getState().workspaces.find((w) => pathsEqual(w.path, path))
      if (!ws) {
        await createWorkspace(workspaceNameFromFolderPath(path), path)
        ws = useAppStore.getState().workspaces.find((w) => pathsEqual(w.path, path))
      }
      if (ws) {
        if (!(await activateWorkspace(ws.id))) return
        goChatUnlessError()
      }
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
      if (!(await activateWorkspace(activeWorkspace.id))) return
      if (useAppStore.getState().piStatus === 'error') return
      await createNewSession()
      requestChatScrollToBottom()
      setCurrentView('chat')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className={clsx('mx-auto max-w-[952px] px-8 py-12', busy && 'pointer-events-none opacity-60')}>
        <PiErrorBanner />

        <div className="mb-6 flex flex-col items-center text-center">
          <img src={piLogo} alt="Pi Desktop" className="h-16 w-16" />
          <h1 className="mt-4 text-2xl font-semibold text-primary">Pi Desktop</h1>
          <p className="mt-1 text-sm text-dim">Open a workspace or pick up where you left off.</p>
        </div>

        <div className="mb-6 grid gap-3 sm:grid-cols-3">
          <button
            onClick={() => void openFolder()}
            className="flex w-full items-center gap-3 rounded-lg border border-border-strong bg-surface px-4 py-3 text-left transition-colors hover:border-border-strong-hover hover:bg-surface-hover"
          >
            <FolderOpen size={18} className="shrink-0 text-muted" />
            <div className="min-w-0">
              <div className="text-sm font-medium text-primary">Open Folder</div>
              <div className="text-xs text-dim">Browse for a project to open as a workspace</div>
            </div>
          </button>
          <button
            onClick={() => void newSession()}
            className="flex w-full items-center gap-3 rounded-lg border border-border bg-surface/50 px-4 py-3 text-left transition-colors hover:border-border-strong hover:bg-surface-hover/60"
          >
            <Plus size={18} className="shrink-0 text-muted" />
            <div className="min-w-0">
              <div className="text-sm font-medium text-primary">New Session</div>
              <div className="truncate text-xs text-dim">
                {activeWorkspace ? `In ${activeWorkspace.name}` : 'Pick a folder first'}
              </div>
            </div>
          </button>
          <button
            onClick={() => setTaskLauncherOpen(true)}
            className="flex w-full items-center gap-3 rounded-lg border border-accent/50 bg-accent-bg/30 px-4 py-3 text-left transition-colors hover:border-accent hover:bg-accent-bg/50"
          >
            <Play size={18} className="shrink-0 text-accent-fg" />
            <div className="min-w-0">
              <div className="text-sm font-medium text-primary">New Task</div>
              <div className="truncate text-xs text-dim">Start work in a fresh Pi session</div>
            </div>
          </button>
        </div>

        <HomeInfoSummary />
      </div>
    </div>
  )
}
