import { TriangleAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { agentEngineLabel } from '../../../shared/agent-engine-label'
import { isRuntimeBusy } from '../../../shared/ipc-contracts'
import { runtimeNeedsPermissionRestart } from '../../../shared/permission-mode'
import { useAppStore } from '../store'
import { PERMISSION_MODE_LABEL_KEYS } from './permission-mode'

/**
 * Tells the user that this session still runs with the tools of an older
 * permission mode. A session in the middle of a turn is never restarted for
 * them, so the notice stays until they restart it after the turn ends.
 */
export function PermissionModeRestartNotice(): React.JSX.Element | null {
  const { t } = useTranslation()
  const mode = useAppStore((state) => state.settings?.permissionMode)
  const runtime = useAppStore((state) =>
    state.activeSessionRuntimeId ? state.sessionRuntimes[state.activeSessionRuntimeId] : undefined
  )
  const restartPi = useAppStore((state) => state.restartPi)
  const engineLabel = useAppStore((state) => agentEngineLabel(state.piEngine) ?? 'Pi')

  if (!mode || !runtime || !runtimeNeedsPermissionRestart(runtime, mode)) return null

  const busy = isRuntimeBusy(runtime.activity)
  const modeLabel = t(PERMISSION_MODE_LABEL_KEYS[mode])
  return (
    <div role="status" className="flex items-center gap-2.5 rounded-md bg-warning/15 px-4 py-2.5 text-sm text-warning shadow-lg shadow-black/30">
      <TriangleAlert size={16} className="shrink-0" />
      <span className="min-w-0 flex-1">
        {busy
          ? t('chat.permissionModeRestart.working', { agent: engineLabel, mode: modeLabel })
          : t('chat.permissionModeRestart.idle', { agent: engineLabel, mode: modeLabel })}
      </span>
      {!busy && (
        <button
          type="button"
          onClick={() => void restartPi()}
          className="shrink-0 rounded-md bg-warning/25 px-2.5 py-1 text-xs font-medium transition-colors hover:bg-warning/40"
        >
          {t('chat.permissionModeRestart.restart', { agent: engineLabel })}
        </button>
      )}
    </div>
  )
}
