import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { findSessionPreview, getSessionTitle } from '../utils/session-title'
import { processStatusLabel } from '../utils/process-status-label'
import { formatDurationShort } from '../utils/format-duration'
import { formatRelativeTime } from '../utils/format-relative-time'
import { useAppStore } from '../store'
import { DEFAULT_AGENT_ENGINE_LABEL, agentEngineLabel } from '../../../shared/agent-engine-label'
import { invocationToken } from '../../../shared/pi-command'
import type { InstalledSkill, OmpUsageAccount, OmpUsageResult, OmpUsageStatus } from '../../../shared/ipc-contracts'
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
  Gauge,
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

const SCOPE_KEYS = {
  global: 'status.scope.global',
  project: 'status.scope.project',
  package: 'status.scope.package',
  cli: 'status.scope.cli',
} as const satisfies Record<InstalledSkill['source'], string>

export function StatusPopover(): React.JSX.Element {
  const { t } = useTranslation()
  const [isOpen, setIsOpen] = useState(false)
  const [commands, setCommands] = useState<CommandInfo[]>([])
  const [skills, setSkills] = useState<InstalledSkill[]>([])
  const [mcpServers, setMcpServers] = useState<McpServer[]>([])
  const [loading, setLoading] = useState(false)
  const [usage, setUsage] = useState<OmpUsageResult | null>(null)
  const [usageLoading, setUsageLoading] = useState(false)
  // Reset countdowns tick while the popover is open.
  const [now, setNow] = useState(() => Date.now())

  const piStatus = useAppStore((state) => state.piStatus)
  const piEngine = useAppStore((state) => state.piEngine)
  const engineLabel = useAppStore((state) => agentEngineLabel(state.piEngine) ?? DEFAULT_AGENT_ENGINE_LABEL)
  const piPid = useAppStore((state) => state.piPid)
  const piError = useAppStore((state) => state.piError)
  const [errorCopied, setErrorCopied] = useState(false)
  const sessionState = useAppStore((state) => state.sessionState)
  const sessionList = useAppStore((state) => state.sessionList)
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

  // Account usage limits (`omp usage`). Main answers null when the engine in
  // view is Pi, which has no equivalent, so the section stays hidden.
  const loadUsage = useCallback(async () => {
    setUsageLoading(true)
    try {
      setUsage(await window.piDesktop.ompUsage.get())
    } catch (err) {
      setUsage({ ok: false, error: err instanceof Error ? err.message : String(err) })
    } finally {
      setUsageLoading(false)
      setNow(Date.now())
    }
  }, [])

  useEffect(() => {
    if (isOpen) void loadUsage()
  }, [isOpen, piEngine, loadUsage])

  useEffect(() => {
    if (!isOpen) return
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
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
    running: 'bg-success',
    starting: 'bg-warning animate-pulse',
    error: 'bg-error',
    stopped: 'bg-elevated',
  }[piStatus]

  return (
    <div ref={ref} className="relative">
      {/* Status trigger */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-surface-hover transition-colors"
        title={t('status.trigger.title')}
      >
        <div className={clsx('h-2 w-2 rounded-full', statusColor)} />
        <Activity size={12} className="text-muted" />
      </button>

      {/* Popover */}
      {isOpen && (
        <div className="absolute top-full left-0 mt-1 w-80 rounded-xl border border-border-strong bg-surface shadow-2xl shadow-black/50 overflow-hidden animate-fade-in z-50">
          {/* Header */}
          <div className="px-4 py-3 border-b border-border bg-surface/50">
            <div className="flex items-center gap-2">
              <Activity size={16} className="text-muted" />
              <span className="text-sm font-medium text-primary">{t('status.header.title')}</span>
            </div>
          </div>

          <div className="max-h-[70vh] overflow-y-auto">
            {/* Agent process */}
            <StatusSection title={t('status.agentSection.title', { agent: engineLabel })} icon={<Cpu size={13} />}>
              <StatusRow
                label={t('status.row.status')}
                value={
                  <span className="flex items-center gap-1.5">
                    <span className={clsx('h-1.5 w-1.5 rounded-full', statusColor)} />
                    {processStatusLabel(piStatus, t)}
                    {piPid && <span className="text-faint">{t('status.pidLabel', { pid: piPid })}</span>}
                  </span>
                }
              />
              {piError && (
                <div className="mt-2 rounded-md border border-error-bg bg-error-bg p-2">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] uppercase tracking-wide text-error font-semibold">{t('status.row.error')}</span>
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard.writeText(piError)
                        setErrorCopied(true)
                        setTimeout(() => setErrorCopied(false), 1500)
                      }}
                      className="text-[10px] text-error/80 hover:text-error"
                    >
                      {errorCopied ? t('status.errorCopied') : t('status.errorCopy')}
                    </button>
                  </div>
                  <pre className="text-[11px] text-error whitespace-pre-wrap break-words max-h-40 overflow-y-auto font-mono">
                    {piError}
                  </pre>
                </div>
              )}
              {sessionState?.model && (
                <StatusRow
                  label={t('status.row.model')}
                  value={
                    <span className="flex items-center gap-1">
                      {sessionState.model.name}
                      {sessionState.model.reasoning && (
                        <Brain size={10} className="text-special" />
                      )}
                    </span>
                  }
                />
              )}
              {sessionState?.model && (
                <StatusRow label={t('status.row.provider')} value={sessionState.model.provider} />
              )}
              {sessionState?.thinkingLevel && (
                <StatusRow
                  label={t('common.thinking')}
                  value={
                    <span className="flex items-center gap-1">
                      <Zap size={10} className="text-warning" />
                      {sessionState.thinkingLevel}
                    </span>
                  }
                />
              )}
              {sessionState?.sessionId && (
                <StatusRow label={t('status.row.session')} value={getSessionTitle(sessionState.sessionName, sessionState.sessionId, findSessionPreview(sessionList, sessionState.sessionFile))} />
              )}
            </StatusSection>

            {/* Context & Tokens */}
            {sessionStats && (
              <StatusSection title={t('status.contextSection.title')} icon={<Layers size={13} />}>
                {sessionStats.contextUsage && (
                  <>
                    <StatusRow
                      label={t('status.row.window')}
                      value={`${((sessionStats.contextUsage.tokens ?? 0) / 1000).toFixed(0)}k / ${(sessionStats.contextUsage.contextWindow / 1000).toFixed(0)}k`}
                    />
                    <StatusRow
                      label={t('status.row.usage')}
                      value={
                        <div className="flex items-center gap-2">
                          <UsageBar percent={contextPct} tone={usageTone(contextPct)} />
                          <span className="text-[11px] w-8 shrink-0 text-right tabular-nums">
                            {contextPct}%
                          </span>
                        </div>
                      }
                    />
                  </>
                )}
                <StatusRow label={t('status.row.messages')} value={String(sessionStats.totalMessages)} />
                <StatusRow label={t('status.row.cost')} value={`$${sessionStats.cost.toFixed(4)}`} />
                <StatusRow
                  label={t('status.row.tokens')}
                  value={`${((sessionStats.tokens.input + sessionStats.tokens.output) / 1000).toFixed(1)}k`}
                />
                <button
                  onClick={() => compactContext()}
                  disabled={isCompacting}
                  className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-md bg-card px-3 py-1.5 text-xs text-secondary hover:bg-elevated disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  title={t('status.compactButton.title')}
                >
                  {isCompacting ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Minimize2 size={12} />
                  )}
                  {isCompacting ? t('status.compactButton.compacting') : t('status.compactButton.compact')}
                </button>
              </StatusSection>
            )}

            {/* Account usage limits (OMP) */}
            {(usage || (usageLoading && piEngine === 'omp')) && (
              <StatusSection title={t('status.usageSection.title')} icon={<Gauge size={13} />}>
                {!usage ? (
                  <div className="flex justify-center py-1">
                    <Loader2 size={12} className="animate-spin text-dim" />
                  </div>
                ) : !usage.ok ? (
                  <div className="text-[11px] text-error line-clamp-3 break-words" title={usage.error}>
                    {usage.error}
                  </div>
                ) : usage.report.accounts.length === 0 ? (
                  <div className="text-xs text-faint py-1">{t('status.usage.noAccounts')}</div>
                ) : (
                  <>
                    {usage.report.accounts.map((account, index) => (
                      <UsageAccountRows key={`${account.provider}:${account.account ?? index}`} account={account} now={now} />
                    ))}
                    {usage.report.capacity
                      .filter((row) => row.accounts > 1)
                      .map((row) => (
                        <StatusRow
                          key={`${row.provider}:${row.window}:${row.meter ?? ''}`}
                          label={`${row.provider} ${row.meter ? `${row.window} (${row.meter})` : row.window}`}
                          value={t('status.usage.capacity', {
                            used: row.usedAccounts.toFixed(2),
                            count: row.accounts,
                          })}
                        />
                      ))}
                    {usage.report.fetchedAt !== null && (
                      <div className="text-[10px] text-faint">
                        {t('status.usage.fetched', { time: formatRelativeTime(usage.report.fetchedAt, now) })}
                      </div>
                    )}
                  </>
                )}
              </StatusSection>
            )}

            {/* Workspace */}
            {activeWorkspace && (
              <StatusSection title={t('status.workspaceSection.title')} icon={<Server size={13} />}>
                <StatusRow label={t('status.row.name')} value={activeWorkspace.name} />
                <StatusRow label={t('status.row.path')} value={<span className="truncate block max-w-[180px]">{activeWorkspace.path}</span>} />
              </StatusSection>
            )}

            {/* Extensions */}
            {extensionCommands.length > 0 && (
              <StatusSection title={t('status.extensionsSection.title')} icon={<Plug size={13} />} count={extensionCommands.length}>
                {extensionCommands.slice(0, 10).map((cmd) => (
                  <div key={cmd.name} className="flex items-center gap-2 py-0.5">
                    <CheckCircle2 size={10} className="text-success shrink-0" />
                    <span className="text-xs text-secondary truncate">/{cmd.name}</span>
                    {cmd.description && (
                      <span className="text-[10px] text-faint truncate ml-auto">{cmd.description}</span>
                    )}
                  </div>
                ))}
                {extensionCommands.length > 10 && (
                  <div className="text-[10px] text-faint mt-1">
                    {t('common.moreCount', { count: extensionCommands.length - 10 })}
                  </div>
                )}
              </StatusSection>
            )}

            {/* Skills */}
            {skills.length > 0 && (
              <StatusSection title={t('common.skills')} icon={<Puzzle size={13} />} count={skills.length}>
                {skills.slice(0, 8).map((skill) => (
                  <div key={skill.path} className="flex items-center gap-2 py-0.5">
                    <Puzzle size={10} className="text-special shrink-0" />
                    <span className="text-xs text-secondary truncate">{skill.name}</span>
                    <span className={clsx(
                      'ml-auto text-[10px] px-1 rounded',
                      skill.source === 'global'
                        ? 'bg-accent-bg text-accent-fg'
                        : 'bg-success-bg text-success'
                    )}>
                      {t(SCOPE_KEYS[skill.source])}
                    </span>
                  </div>
                ))}
                {skills.length > 8 && (
                  <div className="text-[10px] text-faint mt-1">
                    {t('common.moreCount', { count: skills.length - 8 })}
                  </div>
                )}
              </StatusSection>
            )}

            {/* MCP Servers */}
            <StatusSection title={t('status.mcpSection.title')} icon={<Plug size={13} />} count={mcpServers.length > 0 ? mcpServers.length : undefined}>
              {mcpServers.length === 0 ? (
                <div className="text-xs text-faint py-1">
                  {t('status.noMcpServers')}
                </div>
              ) : (
                mcpServers.map((server) => (
                  <div key={server.name} className="flex items-center gap-2 py-1">
                    <div className="h-1.5 w-1.5 rounded-full bg-success shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs text-secondary font-medium">{server.name}</div>
                      <div className="text-[10px] text-faint truncate">{server.command} {server.args.join(' ')}</div>
                    </div>
                    <span className={clsx(
                      'text-[10px] px-1 rounded',
                      server.source === 'global'
                        ? 'bg-accent-bg text-accent-fg'
                        : 'bg-success-bg text-success'
                    )}>
                      {t(SCOPE_KEYS[server.source])}
                    </span>
                  </div>
                ))
              )}
            </StatusSection>

            {/* Prompt Templates */}
            {promptCommands.length > 0 && (
              <StatusSection title={t('status.promptTemplatesSection.title')} icon={<FileText size={13} />} count={promptCommands.length}>
                {promptCommands.slice(0, 6).map((cmd) => (
                  <div key={cmd.name} className="flex items-center gap-2 py-0.5">
                    <FileText size={10} className="text-info shrink-0" />
                    <span className="text-xs text-secondary truncate">/{cmd.name}</span>
                  </div>
                ))}
              </StatusSection>
            )}

            {/* MCP / Skill Commands */}
            {skillCommands.length > 0 && (
              <StatusSection title={t('status.skillCommandsSection.title')} icon={<BookOpen size={13} />} count={skillCommands.length}>
                {skillCommands.slice(0, 6).map((cmd) => (
                  <div key={cmd.name} className="flex items-center gap-2 py-0.5">
                    <BookOpen size={10} className="text-warning shrink-0" />
                    <span className="text-xs text-secondary truncate">{invocationToken(cmd.name, cmd.source)}</span>
                  </div>
                ))}
              </StatusSection>
            )}

            {/* Loading */}
            {loading && (
              <div className="flex items-center justify-center py-4">
                <Loader2 size={16} className="animate-spin text-dim" />
              </div>
            )}

            {/* Empty state */}
            {!loading && commands.length === 0 && skills.length === 0 && (
              <div className="py-6 text-center text-xs text-faint">
                {t('status.noExtensionsOrSkills')}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="px-4 py-2 border-t border-border flex items-center justify-between text-[10px] text-faint">
            <span>v{__APP_VERSION__}</span>
            <button
              onClick={() => {
                useAppStore.getState().refreshSessionStats()
                void loadUsage()
              }}
              className="flex items-center gap-1 hover:text-muted transition-colors"
            >
              <RefreshCw size={10} />
              {t('common.refresh')}
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
    <div className="border-b border-border/50">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-4 py-2 hover:bg-surface-hover/30 transition-colors"
      >
        <span className="text-dim">{icon}</span>
        <span className="text-xs font-medium text-secondary flex-1 text-left">{title}</span>
        {count !== undefined && (
          <span className="text-[10px] text-faint bg-card rounded px-1.5 py-0.5">
            {count}
          </span>
        )}
        <ChevronRight
          size={12}
          className={clsx(
            'text-faint transition-transform',
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

// ─── Usage bar ───────────────────────────────────────────────────────────────

type UsageTone = 'success' | 'warning' | 'error'

const TONE_CLASSES = {
  success: 'bg-success',
  warning: 'bg-warning',
  error: 'bg-error',
} as const satisfies Record<UsageTone, string>

/** Bar color for a used percentage; OMP's own warning/exhausted status wins when it is worse. */
function usageTone(percent: number, status?: OmpUsageStatus): UsageTone {
  if (status === 'exhausted' || percent > 80) return 'error'
  if (status === 'warning' || percent > 60) return 'warning'
  return 'success'
}

function UsageBar({ percent, tone }: { percent: number; tone: UsageTone }): React.JSX.Element {
  return (
    <div className="flex-1 h-1.5 bg-card rounded-full overflow-hidden">
      <div
        className={clsx('h-full rounded-full transition-all', TONE_CLASSES[tone])}
        style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
      />
    </div>
  )
}

// ─── Usage account ───────────────────────────────────────────────────────────

function UsageAccountRows({ account, now }: { account: OmpUsageAccount; now: number }): React.JSX.Element {
  const { t } = useTranslation()
  const { resets } = account
  return (
    <div className="py-0.5 space-y-1">
      <div className="flex items-baseline gap-1.5 min-w-0 text-[11px]">
        <span className="shrink-0 font-medium text-secondary">{account.provider}</span>
        {account.account && (
          <span className="truncate text-faint" title={account.account}>{account.account}</span>
        )}
        {account.org && (
          <span className="ml-auto shrink-0 max-w-[40%] truncate text-faint" title={account.org}>{account.org}</span>
        )}
      </div>
      {account.limits.map((limit) => {
        const percent = limit.usedFraction === null ? null : Math.round(limit.usedFraction * 1000) / 10
        return (
          <div key={limit.id}>
            <div className="flex items-center gap-2">
              <span className="w-28 shrink-0 truncate text-[11px] text-dim" title={limit.label}>{limit.label}</span>
              {percent === null ? (
                <span className="ml-auto text-[11px] text-faint">{t('status.usage.unknownAmount')}</span>
              ) : (
                <>
                  <UsageBar percent={percent} tone={usageTone(percent, limit.status)} />
                  <span className="w-11 shrink-0 text-right text-[11px] tabular-nums text-secondary">
                    {percent.toFixed(1)}%
                  </span>
                </>
              )}
            </div>
            {limit.resetsAt !== null && (
              <div className="text-right text-[10px] text-faint">
                {t('status.usage.resetsIn', { duration: formatDurationShort(limit.resetsAt - now) })}
              </div>
            )}
          </div>
        )
      })}
      {resets && resets.available > 0 && (
        <div className="flex flex-wrap gap-x-2 text-[10px] text-faint">
          <span>{t('status.usage.savedResets', { count: resets.available })}</span>
          <span>{t('status.usage.usableNow', { count: resets.usable })}</span>
          {resets.soonestExpiresAt !== null && (
            <span>{t('status.usage.resetsExpire', { duration: formatDurationShort(resets.soonestExpiresAt - now) })}</span>
          )}
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
    <div className="flex items-start justify-between gap-3 py-0.5">
      <span className="shrink-0 text-[11px] text-dim">{label}</span>
      <span
        className="min-w-0 text-right text-[11px] text-secondary line-clamp-2 break-words"
        title={typeof value === 'string' ? value : undefined}
      >
        {value}
      </span>
    </div>
  )
}
