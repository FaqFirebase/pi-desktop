import { AlertCircle, CheckCircle2, Loader2, XCircle } from 'lucide-react'
import type { SessionRuntimeInfo } from '../../../shared/ipc-contracts'
import { DEFAULT_AGENT_ENGINE_LABEL, agentEngineLabel } from '../../../shared/agent-engine-label'

export function SessionRuntimeIndicator({ runtime }: { runtime: SessionRuntimeInfo }): React.JSX.Element | null {
  const working = runtime.activity === 'working' || runtime.status === 'starting'
  const needsApproval = runtime.activity === 'needs-approval'
  const completed = runtime.activity === 'completed'
  const failed = runtime.activity === 'failed' || runtime.status === 'error'
  // Each runtime names its own engine: the sidebar can show a Pi session and an
  // OMP session at once, so a screen reader must not call both of them Pi.
  const agent = agentEngineLabel(runtime.engine) ?? DEFAULT_AGENT_ENGINE_LABEL

  if (working) {
    return <Loader2 size={12} className="shrink-0 animate-spin text-accent-fg" aria-label={`${agent} is working`} />
  }
  if (needsApproval) {
    return <AlertCircle size={12} className="shrink-0 text-warning" aria-label={`${agent} is waiting for approval`} />
  }
  if (completed) {
    return <CheckCircle2 size={12} className="shrink-0 text-success" aria-label={`${agent} finished`} />
  }
  if (failed) {
    return <XCircle size={12} className="shrink-0 text-error" aria-label={`${agent} stopped with an error`} />
  }
  return null
}
