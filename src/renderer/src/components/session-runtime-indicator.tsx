import { AlertCircle, CheckCircle2, Loader2, XCircle } from 'lucide-react'
import type { SessionRuntimeInfo } from '../../../shared/ipc-contracts'

export function SessionRuntimeIndicator({ runtime }: { runtime: SessionRuntimeInfo }): React.JSX.Element | null {
  const working = runtime.activity === 'working' || runtime.status === 'starting'
  const needsApproval = runtime.activity === 'needs-approval'
  const completed = runtime.activity === 'completed'
  const failed = runtime.activity === 'failed' || runtime.status === 'error'

  if (working) {
    return <Loader2 size={12} className="shrink-0 animate-spin text-accent-fg" aria-label="Pi is working" />
  }
  if (needsApproval) {
    return <AlertCircle size={12} className="shrink-0 text-warning" aria-label="Pi is waiting for approval" />
  }
  if (completed) {
    return <CheckCircle2 size={12} className="shrink-0 text-success" aria-label="Pi finished" />
  }
  if (failed) {
    return <XCircle size={12} className="shrink-0 text-error" aria-label="Pi stopped with an error" />
  }
  return null
}
