import { t } from '../../../shared/i18n'
import { formatShortcut } from '../../../shared/keyboard-shortcuts'

/** The Tools button names the saved global shortcut, or says where to set one. */
export function quickChatEntryTitle(shortcut: string | null, platform: string): string {
  return shortcut
    ? t('sidebar.tools.quickChatTitleWithShortcut', { shortcut: formatShortcut(shortcut, platform) })
    : t('sidebar.tools.quickChatTitleNoShortcut')
}
