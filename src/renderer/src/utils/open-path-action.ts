import { t } from '../../../shared/i18n'
import type { OpenPathRequest } from '../../../shared/editors'
import { useAppStore } from '../store'
import { openPathRefusalPrompt } from './open-path-refusal'

/**
 * Run an open-path action. A terminal editor shows its editor tab; a refusal
 * shows its reason and, when there is one, offers the action that still works.
 */
export async function runOpenPath(request: OpenPathRequest): Promise<void> {
  const result = await window.piDesktop.system.openPath(request)
  const { showEditorTerminal, requestConfirm } = useAppStore.getState()
  if (result.editorTerminalWorkspaceId) showEditorTerminal(result.editorTerminalWorkspaceId)
  if (result.ok) return
  const { message, followUp } = openPathRefusalPrompt(result.refusal, t)
  const confirmed = await requestConfirm({
    title: t('openPath.refusalTitle'),
    message,
    confirmLabel: followUp === 'reveal'
      ? t('openPath.followUp.reveal')
      : followUp === 'system' ? t('openPath.followUp.system') : t('common.close'),
  })
  if (confirmed && followUp) await runOpenPath({ action: followUp, path: request.path })
}
