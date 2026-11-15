import type { Translate } from '../../../shared/i18n'
import type { OpenPathAction, OpenPathRefusal } from '../../../shared/editors'

/**
 * Why an open-path action was refused, and the action to offer instead. The
 * translator parameter is named `t` so `i18next-cli` finds the keys.
 */
export function openPathRefusalPrompt(refusal: OpenPathRefusal, t: Translate): { message: string; followUp: OpenPathAction | null } {
  switch (refusal) {
    case 'outside-roots':
      return { message: t('openPath.refusal.outsideRoots'), followUp: null }
    case 'not-found':
      return { message: t('openPath.refusal.notFound'), followUp: null }
    case 'runnable-file':
      return { message: t('openPath.refusal.runnableFile'), followUp: 'reveal' }
    case 'launch-failed':
      return { message: t('openPath.refusal.launchFailed'), followUp: 'system' }
    case 'system-open-failed':
      return { message: t('openPath.refusal.systemOpenFailed'), followUp: 'reveal' }
    case 'no-terminal-workspace':
      return { message: t('openPath.refusal.noTerminalWorkspace'), followUp: null }
    case 'editor-running':
      return { message: t('openPath.refusal.editorRunning'), followUp: null }
  }
}
