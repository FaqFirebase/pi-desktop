import { useCallback, useEffect, useState } from 'react'
import { clsx } from 'clsx'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Stethoscope,
  XCircle,
} from 'lucide-react'
import type {
  AppLogEntry,
  DiagnosticsReport,
  GitAvailability,
  PermissionMode,
  PiResolutionSource,
  ProviderKeyState,
} from '../../../shared/ipc-contracts'
import { useAppStore } from '../store'
import { DEFAULT_AGENT_ENGINE_LABEL, agentEngineLabel } from '../../../shared/agent-engine-label'
import { formatRelativeTime } from '../utils/format-relative-time'
import { formatIpcError } from '../utils/ipc-error'
import { processStatusLabel } from '../utils/process-status-label'
import { CopyButton } from './copy-button'

type RowTone = 'ok' | 'warn' | 'fail' | 'plain'

const TONE_TEXT: Record<Exclude<RowTone, 'plain'>, string> = {
  ok: 'text-success',
  warn: 'text-warning',
  fail: 'text-error',
}

/** Newest log entries shown in the Recent Errors section. */
const MAX_VISIBLE_LOG_ENTRIES = 30

// Explicit key map so `i18next-cli` can resolve every literal key (the lookup
// value has a union type it cannot trace through a template literal).
const KEY_STATE_LABEL_KEYS = {
  literal: 'diagnostics.keyState.literal',
  'env-set': 'diagnostics.keyState.envSet',
  'env-missing': 'diagnostics.keyState.envMissing',
  shell: 'diagnostics.keyState.shell',
  none: 'diagnostics.keyState.none',
} as const satisfies Record<ProviderKeyState, string>

/** The resolution source that names the agent in its label. */
const ENGINE_INSTALL_SOURCE = 'omp'

// The copied report keeps the raw values; only the panel shows these labels.
const RESOLUTION_SOURCE_LABEL_KEYS = {
  override: 'diagnostics.resolutionSource.override',
  'npm-prefix': 'diagnostics.resolutionSource.npmPrefix',
  path: 'diagnostics.resolutionSource.path',
  'version-manager': 'diagnostics.resolutionSource.versionManager',
  'common-location': 'diagnostics.resolutionSource.commonLocation',
  fallback: 'diagnostics.resolutionSource.fallback',
} as const satisfies Record<Exclude<PiResolutionSource, typeof ENGINE_INSTALL_SOURCE>, string>

const PERMISSION_MODE_LABEL_KEYS = {
  'plan-readonly': 'permissionMode.plan-readonly.label',
  'ask-edits': 'permissionMode.ask-edits.label',
  'ask-commands': 'permissionMode.ask-commands.label',
  trusted: 'permissionMode.trusted.label',
} as const satisfies Record<PermissionMode, string>

const KEY_STATE_TONE: Record<ProviderKeyState, RowTone> = {
  literal: 'ok',
  'env-set': 'ok',
  'env-missing': 'fail',
  shell: 'plain',
  none: 'plain',
}

export function DiagnosticsPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const [report, setReport] = useState<DiagnosticsReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  // The report describes whichever CLI resolved, so labelling it "Pi version"
  // while OMP is configured reports the wrong program's version number.
  const engineLabel = useAppStore((state) => agentEngineLabel(state.piEngine) ?? DEFAULT_AGENT_ENGINE_LABEL)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setReport(await window.piDesktop.diagnostics.get())
      setLoadError(null)
    } catch (err) {
      setLoadError(formatIpcError(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Stethoscope size={16} className="text-muted" />
          <h2 className="text-sm font-medium text-primary">{t('diagnostics.title')}</h2>
        </div>
        <div className="flex items-center gap-2">
          {report && (
            <CopyButton
              text={JSON.stringify(report, null, 2)}
              className="rounded p-1.5 text-dim hover:bg-surface-hover hover:text-secondary transition-colors"
            />
          )}
          <button
            onClick={() => void load()}
            title={t('common.refresh')}
            aria-label={t('diagnostics.refreshAriaLabel')}
            className="rounded p-1.5 text-dim hover:bg-surface-hover hover:text-secondary transition-colors"
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {loading && !report ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={24} className="animate-spin text-dim" />
          </div>
        ) : loadError !== null ? (
          <div className="flex flex-col items-center justify-center py-12 text-dim">
            <AlertTriangle size={32} className="mb-3 text-warning" />
            <p className="text-sm text-secondary">{t('diagnostics.loadErrorTitle')}</p>
            <p className="mt-1 max-w-md break-words px-4 text-center text-xs text-faint">{loadError}</p>
            <button
              onClick={() => void load()}
              className="mt-3 rounded bg-card px-3 py-1 text-xs text-secondary transition-colors hover:bg-surface-hover"
            >
              {t('common.retry')}
            </button>
          </div>
        ) : report ? (
          <div className="mx-auto max-w-3xl space-y-6">
            <DiagSection title={t('diagnostics.sections.application')}>
              <DiagRow label={t('diagnostics.fields.appVersion')} value={report.app.version} />
              <DiagRow label={t('diagnostics.fields.electron')} value={report.app.electron} />
              <DiagRow label={t('diagnostics.fields.chromium')} value={report.app.chrome} />
              <DiagRow label={t('diagnostics.fields.node')} value={report.app.node} />
              <DiagRow label={t('diagnostics.fields.platform')} value={report.app.platform} />
            </DiagSection>

            <DiagSection title={t('diagnostics.sections.binaryTitle', { agent: engineLabel })}>
              {report.piBinary.failureReason && (
                <div className="mb-2 whitespace-pre-wrap rounded-md border border-border bg-error-bg px-3 py-2 text-xs text-error">
                  {report.piBinary.failureReason}
                </div>
              )}
              {report.piBinary.rejectedOverride && (
                <div className="mb-2 rounded-md border border-border bg-warning-bg px-3 py-2 text-xs text-warning">
                  {t('diagnostics.fields.rejectedOverride', { path: report.piBinary.rejectedOverride })}
                </div>
              )}
              <DiagRow
                label={t('diagnostics.fields.binaryFound')}
                value={report.piBinary.found ? t('common.yes') : t('common.no')}
                tone={report.piBinary.found ? 'ok' : 'fail'}
              />
              <DiagRow
                label={t('diagnostics.fields.engineVersion', { agent: engineLabel })}
                value={report.piVersion ?? t('diagnostics.fields.unknownVersion')}
                tone={report.piVersion ? 'plain' : 'warn'}
              />
              <DiagRow label={t('diagnostics.fields.script')} value={report.piBinary.script} mono />
              <DiagRow
                label={t('diagnostics.fields.resolutionSource')}
                value={
                  report.piBinary.source === ENGINE_INSTALL_SOURCE
                    ? t('diagnostics.resolutionSource.engineInstall', { agent: agentEngineLabel(ENGINE_INSTALL_SOURCE) })
                    : t(RESOLUTION_SOURCE_LABEL_KEYS[report.piBinary.source])
                }
              />
              {report.piBinary.useNode && (
                <DiagRow
                  label={t('diagnostics.fields.nodeBinary')}
                  value={report.piBinary.nodeBinary}
                  mono
                  tone={report.piBinary.nodeFound ? 'plain' : 'fail'}
                />
              )}
              <DiagRow
                label={t('diagnostics.fields.needsShell')}
                value={report.piBinary.needsShell ? t('common.yes') : t('common.no')}
              />
              <DiagRow label={t('diagnostics.fields.pathEntriesSearched')} value={String(report.piBinary.pathEntryCount)} />
            </DiagSection>

            <DiagSection title={t('diagnostics.sections.git')}>
              <GitVersionRow git={report.git} />
            </DiagSection>

            <DiagSection title={t('diagnostics.sections.workspaces')}>
              {report.workspaces.length === 0 ? (
                <p className="text-xs text-dim">{t('diagnostics.noWorkspaces')}</p>
              ) : (
                report.workspaces.map((ws) => (
                  <div key={ws.id} className="flex items-center gap-2 py-1 text-xs">
                    <StatusGlyph tone={ws.pathExists ? 'ok' : 'fail'} />
                    <span className="shrink-0 text-secondary">{ws.name}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-faint" title={ws.path}>
                      {ws.path}
                    </span>
                    {!ws.pathExists && <span className="shrink-0 text-error">{t('diagnostics.workspacePathMissing')}</span>}
                    {ws.trusted && <span className="shrink-0 text-success">{t('diagnostics.workspaceTrustedBadge')}</span>}
                    <span className="shrink-0 text-muted">{processStatusLabel(ws.piStatus, t)}</span>
                  </div>
                ))
              )}
            </DiagSection>

            <DiagSection title={t('diagnostics.sections.providers')}>
              {report.providersError ? (
                <div className="flex items-center gap-2 text-xs text-warning">
                  <AlertTriangle size={13} className="shrink-0" />
                  <span className="min-w-0 flex-1 break-words">{report.providersError}</span>
                </div>
              ) : !report.providers || report.providers.length === 0 ? (
                <p className="text-xs text-dim">{t('diagnostics.noCustomProviders')}</p>
              ) : (
                report.providers.map((provider) => {
                  const keyTone = KEY_STATE_TONE[provider.keyState]
                  return (
                    <div key={provider.name} className="flex items-center gap-2 py-1 text-xs">
                      <StatusGlyph tone={keyTone === 'plain' ? 'ok' : keyTone} />
                      <span className="shrink-0 text-secondary">{provider.name}</span>
                      <span className="shrink-0 text-faint">
                        {t('diagnostics.providerModelCount', { count: provider.modelCount })}
                      </span>
                      <span
                        className={clsx(
                          'min-w-0 flex-1 truncate text-right',
                          keyTone === 'plain' ? 'text-muted' : TONE_TEXT[keyTone]
                        )}
                        title={provider.envVar ? `$${provider.envVar}` : undefined}
                      >
                        {t(KEY_STATE_LABEL_KEYS[provider.keyState])}
                        {provider.envVar ? ` ($${provider.envVar})` : ''}
                      </span>
                    </div>
                  )
                })
              )}
            </DiagSection>

            <DiagSection title={t('diagnostics.sections.permissions')}>
              <DiagRow
                label={t('diagnostics.fields.mode')}
                value={t(PERMISSION_MODE_LABEL_KEYS[report.permissions.mode])}
              />
              <DiagRow
                label={t('diagnostics.fields.globalRules')}
                value={
                  report.permissions.globalRuleCount === null
                    ? t('diagnostics.fields.globalRulesInvalid', {
                        error: report.permissions.globalRulesError ?? t('diagnostics.fields.unknownError'),
                      })
                    : String(report.permissions.globalRuleCount)
                }
                tone={report.permissions.globalRuleCount === null ? 'fail' : 'plain'}
              />
              <DiagRow
                label={t('diagnostics.fields.workspaceRules')}
                value={
                  !report.permissions.workspace.hasWorkspaceRules
                    ? t('diagnostics.fields.workspaceRulesNone')
                    : report.permissions.workspace.hasAllowRules
                      ? t('diagnostics.fields.workspaceRulesPresentWithAllowRules')
                      : t('diagnostics.fields.workspaceRulesPresent')
                }
              />
              {report.permissions.workspace.workspacePath && (
                <DiagRow
                  label={t('diagnostics.fields.workspaceTrust')}
                  value={
                    report.permissions.workspace.trusted
                      ? t('diagnostics.workspaceTrustedBadge')
                      : t('diagnostics.workspaceNotTrustedBadge')
                  }
                  tone={
                    report.permissions.workspace.hasAllowRules && !report.permissions.workspace.trusted
                      ? 'warn'
                      : 'plain'
                  }
                />
              )}
            </DiagSection>

            <DiagSection title={t('diagnostics.sections.storage')}>
              <DiagRow label={t('diagnostics.fields.guiDataDir')} value={report.storage.guiDataDir} mono />
              <DiagRow label={t('diagnostics.fields.settingsFile')} value={report.storage.settingsPath} mono />
              <DiagRow
                label={t('diagnostics.fields.sessionsRoot')}
                value={report.storage.sessionsRoot}
                mono
                tone={report.storage.sessionsRootExists ? 'plain' : 'warn'}
              />
            </DiagSection>

            <DiagSection title={t('diagnostics.sections.recentErrors')}>
              {report.recentErrors.length === 0 ? (
                <p className="text-xs text-dim">{t('diagnostics.noRecentErrors')}</p>
              ) : (
                <div className="space-y-1">
                  {report.recentErrors.slice(-MAX_VISIBLE_LOG_ENTRIES).map((entry, index) => (
                    <LogEntryRow key={`${entry.ts}-${index}`} entry={entry} now={report.generatedAt} />
                  ))}
                </div>
              )}
            </DiagSection>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function DiagSection({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section>
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-dim">{title}</h3>
      <div className="rounded-md border border-border bg-surface/50 px-3 py-2">{children}</div>
    </section>
  )
}

function GitVersionRow({ git }: { git: GitAvailability }): React.JSX.Element {
  const { t } = useTranslation()
  const label = t('diagnostics.fields.gitVersion')
  switch (git.status) {
    case 'found':
      return <DiagRow label={label} value={git.version} mono />
    case 'missing':
      return <DiagRow label={label} value={t('diagnostics.fields.gitNotFound')} tone="fail" />
    case 'failed':
      return <DiagRow label={label} value={t('diagnostics.fields.gitFailed', { detail: git.detail })} tone="warn" />
  }
}

function DiagRow({
  label,
  value,
  tone = 'plain',
  mono = false,
}: {
  label: string
  value: string
  tone?: RowTone
  mono?: boolean
}): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1 text-xs">
      <span className="shrink-0 text-muted">{label}</span>
      <span
        className={clsx(
          'min-w-0 break-all text-right',
          mono && 'font-mono',
          tone === 'plain' ? 'text-secondary' : TONE_TEXT[tone]
        )}
      >
        {value}
      </span>
    </div>
  )
}

function StatusGlyph({ tone }: { tone: Exclude<RowTone, 'plain'> }): React.JSX.Element {
  if (tone === 'ok') return <CheckCircle2 size={13} className="shrink-0 text-success" />
  if (tone === 'warn') return <AlertTriangle size={13} className="shrink-0 text-warning" />
  return <XCircle size={13} className="shrink-0 text-error" />
}

function LogEntryRow({ entry, now }: { entry: AppLogEntry; now: number }): React.JSX.Element {
  return (
    <div className="flex items-start gap-2 text-xs" title={entry.detail}>
      <span
        className={clsx(
          'shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase',
          entry.level === 'error' ? 'bg-error-bg text-error' : 'bg-warning-bg text-warning'
        )}
      >
        {entry.level}
      </span>
      <span className="shrink-0 text-faint">{formatRelativeTime(entry.ts, now)}</span>
      <span className="shrink-0 text-muted">[{entry.scope}]</span>
      <span className="min-w-0 flex-1 break-words text-secondary">{entry.message}</span>
    </div>
  )
}
