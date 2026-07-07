import { useState, useEffect, useRef } from 'react'
import { getSessionTitle } from '../utils/session-title'
import { useAppStore } from '../store'
import type { InstalledSkill } from '../../../shared/ipc-contracts'
import { clsx } from 'clsx'
import {
  Activity,
  Cpu,
  Zap,
  Layers,
  Minimize2,
  Puzzle,
  Brain,
  CheckCircle2,
  Loader2,
  ChevronRight,
  RefreshCw,
  Server,
  Plug,
  FileText,
  BookOpen,
} from 'lucide-react'

interface CommandInfo {
  name: string
  description?: string
  source: 'extension' | 'prompt' | 'skill'
  path?: string
}

interface McpServer {
  name: string
  command: string
  args: string[]
  env: Record<string, string>
  source: 'global' | 'project'
  status: 'configured' | 'unknown'
}

export function StatusPopover(): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false)
  const [commands, setCommands] = useState<CommandInfo[]>([])
  const [skills, setSkills] = useState<InstalledSkill[]>([])
  const [mcpServers, setMcpServers] = useState<McpServer[]>([])
  const [loading, setLoading] = useState(false)

  const piStatus = useAppStore((state) => state.piStatus)
  const piPid = useAppStore((state) => state.piPid)
  const piError = useAppStore((state) => state.piError)
  const [errorCopied, setErrorCopied] = useState(false)
  const sessionState = useAppStore((state) => state.sessionState)
  const sessionStats = useAppStore((state) => state.sessionStats)
  const activeWorkspace = useAppStore((state) => state.activeWorkspace)
  const compactContext = useAppStore((state) => state.compactContext)
  const isCompacting = sessionState?.isCompacting ?? false
  const ref = useRef<HTMLDivElement>(null)

  // Some providers (e.g. lmstudio) return a fractional context-usage percent
  // like 1.077270; round + clamp so it fits the fixed-width label instead of
  // overflowing the popover.
  const contextPct = sessionStats?.contextUsage
    ? Math.min(100, Math.max(0, Math.round(sessionStats.contextUsage.percent ?? 0)))
    : 0

  // Load data when opened
  useEffect(() => {
    if (!isOpen) return

    const loadData = async () => {
      setLoading(true)
      try {
        const [cmds, skls, mcp] = await Promise.all([
          window.piDesktop.piCommands.list().catch(() => []),
          window.piDesktop.skills.list().catch(() => []),
          window.piDesktop.mcpServers.list().catch(() => []),
        ])
        setCommands(cmds as CommandInfo[])
        setSkills(skls as InstalledSkill[])
        setMcpServers(mcp as McpServer[])
      } catch {
        // Silent failure
      } finally {
        setLoading(false)
      }
    }

    loadData()
  }, [isOpen])

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return

    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false)
    }

    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [isOpen])

  // Group commands by source
  const extensionCommands = commands.filter((c) => c.source === 'extension')
  const promptCommands = commands.filter((c) => c.source === 'prompt')
  const skillCommands = commands.filter((c) => c.source === 'skill')

  const statusColor = {
    running: 'bg-emerald-500',
    starting: 'bg-yellow-500 animate-pulse',
    error: 'bg-red-500',
    stopped: 'bg-neutral-600',
  }[piStatus]

  return (
    <div ref={ref} className="relative">
      {/* Status trigger */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-neutral-800 transition-colors"
        title="System status"
      >
        <div className={clsx('h-2 w-2 rounded-full', statusColor)} />
        <Activity size={12} className="text-neutral-400" />
      </button>

      {/* Popover */}
      {isOpen && (
        <div className="absolute top-full left-0 mt-1 w-80 rounded-xl border border-neutral-700 bg-neutral-900 shadow-2xl shadow-black/50 overflow-hidden animate-fade-in z-50">
          {/* Header */}
          <div className="px-4 py-3 border-b border-neutral-800 bg-neutral-900/50">
            <div className="flex items-center gap-2">
              <Activity size={16} className="text-neutral-400" />
              <span className="text-sm font-medium text-neutral-200">System Status</span>
            </div>
          </div>

          <div className="max-h-[70vh] overflow-y-auto">
            {/* Pi Agent */}
            <StatusSection title="Pi Agent" icon={<Cpu size={13} />}>
              <StatusRow
                label="Status"
                value={
                  <span className="flex items-center gap-1.5">
                    <span className={clsx('h-1.5 w-1.5 rounded-full', statusColor)} />
                    {piStatus}
                    {piPid && <span className="text-neutral-600">(PID: {piPid})</span>}
                  </span>
                }
              />
              {piError && (
                <div className="mt-2 rounded-md border border-red-800/50 bg-red-950/30 p-2">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] uppercase tracking-wide text-red-400 font-semibold">Error</span>
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard.writeText(piError)
                        setErrorCopied(true)
                        setTimeout(() => setErrorCopied(false), 1500)
                      }}
                      className="text-[10px] text-red-300 hover:text-red-200"
                    >
                      {errorCopied ? 'copied' : 'copy'}
                    </button>
                  </div>
                  <pre className="text-[11px] text-red-200 whitespace-pre-wrap break-words max-h-40 overflow-y-auto font-mono">
                    {piError}
                  </pre>
                </div>
              )}
              {sessionState?.model && (
                <StatusRow
                  label="Model"
                  value={
                    <span className="flex items-center gap-1">
                      {sessionState.model.name}
                      {sessionState.model.reasoning && (
                        <Brain size={10} className="text-purple-400" />
                      )}
                    </span>
                  }
                />
              )}
              {sessionState?.model && (
                <StatusRow label="Provider" value={sessionState.model.provider} />
              )}
              {sessionState?.thinkingLevel && (
                <StatusRow
                  label="Thinking"
                  value={
                    <span className="flex items-center gap-1">
                      <Zap size={10} className="text-yellow-400" />
                      {sessionState.thinkingLevel}
                    </span>
                  }
                />
              )}
              {sessionState?.sessionId && (
                <StatusRow label="Session" value={getSessionTitle(sessionState.sessionName, sessionState.sessionId)} />
              )}
            </StatusSection>

            {/* Context & Tokens */}
            {sessionStats && (
              <StatusSection title="Context Usage" icon={<Layers size={13} />}>
                {sessionStats.contextUsage && (
                  <>
                    <StatusRow
                      label="Window"
                      value={`${((sessionStats.contextUsage.tokens ?? 0) / 1000).toFixed(0)}k / ${(sessionStats.contextUsage.contextWindow / 1000).toFixed(0)}k`}
                    />
                    <StatusRow
                      label="Usage"
                      value={
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1.5 bg-neutral-800 rounded-full overflow-hidden">
                            <div
                              className={clsx(
                                'h-full rounded-full transition-all',
                                contextPct > 80
                                  ? 'bg-red-500'
                                  : contextPct > 60
                                    ? 'bg-yellow-500'
                                    : 'bg-emerald-500'
                              )}
                              style={{ width: `${contextPct}%` }}
                            />
                          </div>
                          <span className="text-xs w-8 shrink-0 text-right tabular-nums">
                            {contextPct}%
                          </span>
                        </div>
                      }
                    />
                  </>
                )}
                <StatusRow label="Messages" value={String(sessionStats.totalMessages)} />
                <StatusRow label="Cost" value={`$${sessionStats.cost.toFixed(4)}`} />
                <StatusRow
                  label="Tokens"
                  value={`${((sessionStats.tokens.input + sessionStats.tokens.output) / 1000).toFixed(1)}k`}
                />
                <button
                  onClick={() => compactContext()}
                  disabled={isCompacting}
                  className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-md bg-neutral-800 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  title="Summarize and compact the conversation to free up context"
                >
                  {isCompacting ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Minimize2 size={12} />
                  )}
                  {isCompacting ? 'Compacting…' : 'Compact context'}
                </button>
              </StatusSection>
            )}

            {/* Workspace */}
            {activeWorkspace && (
              <StatusSection title="Workspace" icon={<Server size={13} />}>
                <StatusRow label="Name" value={activeWorkspace.name} />
                <StatusRow label="Path" value={<span className="truncate block max-w-[180px]">{activeWorkspace.path}</span>} />
              </StatusSection>
            )}

            {/* Extensions */}
            {extensionCommands.length > 0 && (
              <StatusSection title="Extensions" icon={<Plug size={13} />} count={extensionCommands.length}>
                {extensionCommands.slice(0, 10).map((cmd) => (
                  <div key={cmd.name} className="flex items-center gap-2 py-0.5">
                    <CheckCircle2 size={10} className="text-emerald-500 shrink-0" />
                    <span className="text-xs text-neutral-300 truncate">/{cmd.name}</span>
                    {cmd.description && (
                      <span className="text-[10px] text-neutral-600 truncate ml-auto">{cmd.description}</span>
                    )}
                  </div>
                ))}
                {extensionCommands.length > 10 && (
                  <div className="text-[10px] text-neutral-600 mt-1">
                    +{extensionCommands.length - 10} more
                  </div>
                )}
              </StatusSection>
            )}

            {/* Skills */}
            {skills.length > 0 && (
              <StatusSection title="Skills" icon={<Puzzle size={13} />} count={skills.length}>
                {skills.slice(0, 8).map((skill) => (
                  <div key={skill.path} className="flex items-center gap-2 py-0.5">
                    <Puzzle size={10} className="text-purple-400 shrink-0" />
                    <span className="text-xs text-neutral-300 truncate">{skill.name}</span>
                    <span className={clsx(
                      'ml-auto text-[10px] px-1 rounded',
                      skill.source === 'global'
                        ? 'bg-blue-900/20 text-blue-500'
                        : 'bg-emerald-900/20 text-emerald-500'
                    )}>
                      {skill.source}
                    </span>
                  </div>
                ))}
                {skills.length > 8 && (
                  <div className="text-[10px] text-neutral-600 mt-1">
                    +{skills.length - 8} more
                  </div>
                )}
              </StatusSection>
            )}

            {/* MCP Servers */}
            <StatusSection title="MCP Servers" icon={<Plug size={13} />} count={mcpServers.length > 0 ? mcpServers.length : undefined}>
              {mcpServers.length === 0 ? (
                <div className="text-xs text-neutral-600 py-1">
                  No MCP servers configured
                </div>
              ) : (
                mcpServers.map((server) => (
                  <div key={server.name} className="flex items-center gap-2 py-1">
                    <div className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs text-neutral-300 font-medium">{server.name}</div>
                      <div className="text-[10px] text-neutral-600 truncate">{server.command} {server.args.join(' ')}</div>
                    </div>
                    <span className={clsx(
                      'text-[10px] px-1 rounded',
                      server.source === 'global'
                        ? 'bg-blue-900/20 text-blue-500'
                        : 'bg-emerald-900/20 text-emerald-500'
                    )}>
                      {server.source}
                    </span>
                  </div>
                ))
              )}
            </StatusSection>

            {/* Prompt Templates */}
            {promptCommands.length > 0 && (
              <StatusSection title="Prompt Templates" icon={<FileText size={13} />} count={promptCommands.length}>
                {promptCommands.slice(0, 6).map((cmd) => (
                  <div key={cmd.name} className="flex items-center gap-2 py-0.5">
                    <FileText size={10} className="text-cyan-400 shrink-0" />
                    <span className="text-xs text-neutral-300 truncate">/{cmd.name}</span>
                  </div>
                ))}
              </StatusSection>
            )}

            {/* MCP / Skill Commands */}
            {skillCommands.length > 0 && (
              <StatusSection title="Skill Commands" icon={<BookOpen size={13} />} count={skillCommands.length}>
                {skillCommands.slice(0, 6).map((cmd) => (
                  <div key={cmd.name} className="flex items-center gap-2 py-0.5">
                    <BookOpen size={10} className="text-amber-400 shrink-0" />
                    <span className="text-xs text-neutral-300 truncate">/skill:{cmd.name}</span>
                  </div>
                ))}
              </StatusSection>
            )}

            {/* Loading */}
            {loading && (
              <div className="flex items-center justify-center py-4">
                <Loader2 size={16} className="animate-spin text-neutral-500" />
              </div>
            )}

            {/* Empty state */}
            {!loading && commands.length === 0 && skills.length === 0 && (
              <div className="py-6 text-center text-xs text-neutral-600">
                No extensions or skills loaded
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="px-4 py-2 border-t border-neutral-800 flex items-center justify-between text-[10px] text-neutral-600">
            <span>v{__APP_VERSION__}</span>
            <button
              onClick={() => {
                useAppStore.getState().refreshSessionStats()
              }}
              className="flex items-center gap-1 hover:text-neutral-400 transition-colors"
            >
              <RefreshCw size={10} />
              Refresh
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Section ─────────────────────────────────────────────────────────────────

function StatusSection({
  title,
  icon,
  count,
  children,
}: {
  title: string
  icon: React.ReactNode
  count?: number
  children: React.ReactNode
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(true)

  return (
    <div className="border-b border-neutral-800/50">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-4 py-2 hover:bg-neutral-800/30 transition-colors"
      >
        <span className="text-neutral-500">{icon}</span>
        <span className="text-xs font-medium text-neutral-300 flex-1 text-left">{title}</span>
        {count !== undefined && (
          <span className="text-[10px] text-neutral-600 bg-neutral-800 rounded px-1.5 py-0.5">
            {count}
          </span>
        )}
        <ChevronRight
          size={12}
          className={clsx(
            'text-neutral-600 transition-transform',
            expanded && 'rotate-90'
          )}
        />
      </button>
      {expanded && (
        <div className="px-4 pb-2 space-y-1">
          {children}
        </div>
      )}
    </div>
  )
}

// ─── Row ─────────────────────────────────────────────────────────────────────

function StatusRow({
  label,
  value,
}: {
  label: string
  value: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-[11px] text-neutral-500">{label}</span>
      <span className="text-[11px] text-neutral-300">{value}</span>
    </div>
  )
}
