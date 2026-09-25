import { AlertCircle, CheckCircle2, Loader2, XCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { SessionRuntimeInfo } from '../../../shared/ipc-contracts'
import { DEFAULT_AGENT_ENGINE_LABEL, agentEngineLabel } from '../../../shared/agent-engine-label'

export function SessionRuntimeIndicator({ runtime, fallback = null }: {
  runtime: SessionRuntimeInfo
  fallback?: React.JSX.Element | null
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const working = runtime.activity === 'working' || runtime.status === 'starting'
  const needsApproval = runtime.activity === 'needs-approval'
  const completed = runtime.activity === 'completed'
  const failed = runtime.activity === 'failed' || runtime.status === 'error'
  // Each runtime names its own engine: the sidebar can show a Pi session and an
  // OMP session at once, so a screen reader must not call both of them Pi.
  const agent = agentEngineLabel(runtime.engine) ?? DEFAULT_AGENT_ENGINE_LABEL

  if (working) {
    return (
      <Loader2
        size={12}
        className="shrink-0 animate-spin text-accent-fg"
        aria-label={t('sessions.runtime.working', { agent })}
      />
    )
  }
  if (needsApproval) {
    return (
      <AlertCircle
        size={12}
        className="shrink-0 text-warning"
        aria-label={t('sessions.runtime.needsApproval', { agent })}
      />
    )
  }
  if (completed) {
    return (
      <CheckCircle2 size={12} className="shrink-0 text-success" aria-label={t('sessions.runtime.completed', { agent })} />
    )
  }
  if (failed) {
    return <XCircle size={12} className="shrink-0 text-error" aria-label={t('sessions.runtime.failed', { agent })} />
  }
  return fallback
}
