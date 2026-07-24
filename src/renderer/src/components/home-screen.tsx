import { useEffect, useMemo, useRef, useState } from 'react'
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
  ChevronDown,
  Check,
  CornerDownLeft,
} from 'lucide-react'
import { useAppStore } from '../store'
import piLogo from '../assets/pi-logo.svg'
import { formatGitStatus } from './review-rail'
import { StatsPanel } from './stats-panel'
import type { GitFileStatus, SessionListItem, Workspace } from '../../../shared/ipc-contracts'
import { DEFAULT_SETTINGS } from '../../../shared/default-settings'

const MAX_RECENT_WORKSPACES = 6
const MAX_RECENT_SESSIONS = 5
const MAX_CHANGED_FILES = 8

function useHomeLayout(): 'info' | 'minimal' {
  return useAppStore(
    (s) => s.settingsDraft.homeLayout ?? s.settings?.homeLayout ?? DEFAULT_SETTINGS.homeLayout
  )
}

/**
 * Home / launcher. Layout is selected in Settings:
 *  - info: stats + recents splash (legacy)
 *  - minimal: Codex-style center composer with project picker
 */
export function HomeScreen(): React.JSX.Element {
  const layout = useHomeLayout()
  if (layout === 'minimal') return <HomeScreenMinimal />
  return <HomeScreenInfo />
}

/**
 * Info-home content without Open Folder / New Session — stats, changed files,
 * and recents. Shown at the top of Settings so activity stays available when
 * Home is set to Minimal.
 */
export function HomeInfoSummary({ compact }: { compact?: boolean }): React.JSX.Element {
  const workspaces = useAppStore((s) => s.workspaces)
  const activeWorkspace = useAppStore((s) => s.activeWorkspace)
  const sessionList = useAppStore((s) => s.sessionList)
  const archivedSessions = useAppStore((s) => s.archivedSessions)
  const switchWorkspace = useAppStore((s) => s.switchWorkspace)
  const createWorkspace = useAppStore((s) => s.createWorkspace)
  const switchSession = useAppStore((s) => s.switchSession)
  const startPi = useAppStore((s) => s.startPi)
  const setCurrentView = useAppStore((s) => s.setCurrentView)
  const requestChatScrollToBottom = useAppStore((s) => s.requestChatScrollToBottom)

  const [gitStatus, setGitStatus] = useState<Record<string, GitFileStatus>>({})
  const [busy, setBusy] = useState(false)

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

  const openWorkspace = async (workspaceId: string): Promise<void> => {
    setBusy(true)
    try {
      await switchWorkspace(workspaceId)
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
      await switchWorkspace(activeWorkspace.id)
      if (useAppStore.getState().piStatus !== 'error') setCurrentView('diff')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={clsx(busy && 'pointer-events-none opacity-60', compact && 'space-y-4')}>
      <StatsPanel />

      <div className={clsx('grid gap-6', compact ? 'md:grid-cols-2' : 'md:grid-cols-2')}>
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
                        {getSessionTitle(session.name, session.sessionId)}
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

// ─── Shared helpers ──────────────────────────────────────────────────────────

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
        <div className="mt-1 text-xs text-error/70">
          Check that Pi is installed and its path is correct.
        </div>
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
  return <div className="rounded-md border border-border bg-surface/40 px-3 py-2 text-xs text-faint">{children}</div>
}

// ─── Info home (current launcher) ────────────────────────────────────────────

function HomeScreenInfo(): React.JSX.Element {
  const activeWorkspace = useAppStore((s) => s.activeWorkspace)
  const switchWorkspace = useAppStore((s) => s.switchWorkspace)
  const createWorkspace = useAppStore((s) => s.createWorkspace)
  const createNewSession = useAppStore((s) => s.createNewSession)
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
      let ws = useAppStore.getState().workspaces.find((w) => w.path === path)
      if (!ws) {
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

        <div className="mb-6 grid gap-3 sm:grid-cols-2">
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
        </div>

        <HomeInfoSummary />
      </div>
    </div>
  )
}

// ─── Minimal home (Codex-style) ──────────────────────────────────────────────

function HomeScreenMinimal(): React.JSX.Element {
  const workspaces = useAppStore((s) => s.workspaces)
  const activeWorkspace = useAppStore((s) => s.activeWorkspace)
  const sessionList = useAppStore((s) => s.sessionList)
  const archivedSessions = useAppStore((s) => s.archivedSessions)
  const switchWorkspace = useAppStore((s) => s.switchWorkspace)
  const createWorkspace = useAppStore((s) => s.createWorkspace)
  const createNewSession = useAppStore((s) => s.createNewSession)
  const sendPrompt = useAppStore((s) => s.sendPrompt)
  const setCurrentView = useAppStore((s) => s.setCurrentView)
  const requestChatScrollToBottom = useAppStore((s) => s.requestChatScrollToBottom)
  const switchSession = useAppStore((s) => s.switchSession)
  const startPi = useAppStore((s) => s.startPi)

  const sortedWorkspaces = useMemo(
    () => [...workspaces].sort((a, b) => b.lastActiveAt - a.lastActiveAt),
    [workspaces]
  )

  const [selectedId, setSelectedId] = useState<string | null>(
    () => activeWorkspace?.id ?? sortedWorkspaces[0]?.id ?? null
  )
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Keep selection in sync when workspaces load or active changes.
  useEffect(() => {
    if (selectedId && workspaces.some((w) => w.id === selectedId)) return
    setSelectedId(activeWorkspace?.id ?? sortedWorkspaces[0]?.id ?? null)
  }, [activeWorkspace?.id, selectedId, sortedWorkspaces, workspaces])

  useEffect(() => {
    if (!pickerOpen) return
    const onDoc = (e: MouseEvent): void => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [pickerOpen])

  const selected: Workspace | null =
    workspaces.find((w) => w.id === selectedId) ?? activeWorkspace ?? sortedWorkspaces[0] ?? null

  const recentForProject = useMemo(() => {
    if (!selected) return []
    return sessionList
      .filter((s) => !(s.sessionId in archivedSessions))
      .filter((s) => s.projectPath === selected.path)
      .slice(0, MAX_RECENT_SESSIONS)
  }, [sessionList, archivedSessions, selected])

  const openFolder = async (): Promise<void> => {
    const path = await window.piDesktop.system.openDialog({ title: 'Open Folder' })
    if (!path) return
    setBusy(true)
    try {
      let ws = useAppStore.getState().workspaces.find((w) => w.path === path)
      if (!ws) {
        const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path
        await createWorkspace(name, path)
        ws = useAppStore.getState().workspaces.find((w) => w.path === path)
      }
      if (ws) {
        setSelectedId(ws.id)
        setPickerOpen(false)
      }
    } finally {
      setBusy(false)
    }
  }

  const submit = async (): Promise<void> => {
    const text = prompt.trim()
    if (!text || busy) return
    if (!selected) {
      await openFolder()
      return
    }
    setBusy(true)
    try {
      await switchWorkspace(selected.id)
      if (useAppStore.getState().piStatus === 'error') return
      await createNewSession()
      await sendPrompt(text)
      setPrompt('')
      requestChatScrollToBottom()
      setCurrentView('chat')
    } finally {
      setBusy(false)
    }
  }

  const openSession = async (session: SessionListItem): Promise<void> => {
    setBusy(true)
    try {
      if (selected) await switchWorkspace(selected.id)
      else await startPi()
      if (useAppStore.getState().piStatus === 'error') return
      await switchSession(session.path)
      requestChatScrollToBottom()
      setCurrentView('chat')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={clsx('flex flex-1 flex-col overflow-y-auto', busy && 'pointer-events-none opacity-60')}>
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center px-6 py-10">
        <PiErrorBanner />

        <div className="mb-8 flex flex-col items-center text-center">
          <img src={piLogo} alt="Pi Desktop" className="h-14 w-14" />
          <h1 className="mt-4 text-2xl font-semibold text-primary">What should Pi work on?</h1>
          <p className="mt-1 text-sm text-dim">Pick a project and start a new session.</p>
        </div>

        <div className="rounded-2xl border border-border-strong bg-surface shadow-sm focus-within:border-border-strong-hover transition-colors">
          <textarea
            ref={textareaRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void submit()
              }
            }}
            rows={3}
            placeholder="Ask Pi anything — / for commands"
            disabled={busy}
            className="font-chat max-h-40 min-h-[72px] w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-sm leading-relaxed text-primary placeholder:text-faint outline-none disabled:opacity-50"
          />

          <div className="flex items-center gap-1.5 border-t border-border/60 px-2 py-1.5">
            <div ref={pickerRef} className="relative min-w-0 flex-1">
              <button
                type="button"
                onClick={() => setPickerOpen((o) => !o)}
                disabled={busy}
                className="flex max-w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-xs text-secondary hover:bg-highlight-strong transition-colors disabled:opacity-50"
                title={selected?.path ?? 'Select project'}
              >
                <Layers size={14} className="shrink-0 text-muted" style={selected ? { color: selected.color } : undefined} />
                <span className="min-w-0 truncate font-medium text-primary">
                  {selected?.name ?? 'Select project'}
                </span>
                <ChevronDown size={12} className="shrink-0 text-dim" />
              </button>

              {pickerOpen && (
                <div className="absolute bottom-full left-0 z-30 mb-1 max-h-64 w-72 overflow-y-auto rounded-lg border border-border-strong bg-surface py-1 shadow-xl shadow-black/40">
                  {sortedWorkspaces.map((ws) => (
                    <button
                      key={ws.id}
                      type="button"
                      onClick={() => {
                        setSelectedId(ws.id)
                        setPickerOpen(false)
                      }}
                      className={clsx(
                        'flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-surface-hover transition-colors',
                        ws.id === selected?.id && 'bg-card'
                      )}
                    >
                      <Layers size={13} className="shrink-0" style={{ color: ws.color }} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm text-primary">{ws.name}</div>
                        <div className="truncate text-[11px] text-faint">{ws.path}</div>
                      </div>
                      {ws.id === selected?.id && <Check size={12} className="shrink-0 text-success" />}
                    </button>
                  ))}
                  {sortedWorkspaces.length > 0 && <div className="my-1 border-t border-border" />}
                  <button
                    type="button"
                    onClick={() => void openFolder()}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-secondary hover:bg-surface-hover transition-colors"
                  >
                    <FolderOpen size={13} className="shrink-0 text-muted" />
                    Open folder…
                  </button>
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={() => void submit()}
              disabled={busy || !prompt.trim()}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-dim hover:bg-highlight-strong hover:text-secondary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title="Start session (Enter)"
              aria-label="Send"
            >
              <CornerDownLeft size={16} />
            </button>
          </div>
        </div>

        {recentForProject.length > 0 && (
          <div className="mt-8">
            <SectionLabel>Recent in {selected?.name}</SectionLabel>
            <div className="space-y-1">
              {recentForProject.map((session) => (
                <button
                  key={session.path}
                  type="button"
                  onClick={() => void openSession(session)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-secondary hover:bg-surface-hover/60 transition-colors"
                >
                  <Clock size={12} className="shrink-0 text-faint" />
                  <span className="min-w-0 truncate">
                    {getSessionTitle(session.name, session.sessionId)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {!selected && workspaces.length === 0 && (
          <p className="mt-6 text-center text-xs text-faint">
            Open a folder to choose a project, then describe what you want Pi to do.
          </p>
        )}
      </div>
    </div>
  )
}
