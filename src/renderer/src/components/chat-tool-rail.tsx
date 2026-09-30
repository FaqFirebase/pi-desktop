import { useAppStore } from '../store'
import { activeShortcuts } from '../utils/app-shortcuts'
import { formatShortcut } from '../../../shared/keyboard-shortcuts'
import { useTranslation } from 'react-i18next'
import { clsx } from 'clsx'
import { FolderTree, GitCompare, Terminal, ShieldCheck } from 'lucide-react'

export function ChatToolRail(): React.JSX.Element {
  const { t } = useTranslation()
  const reviewOpen = useAppStore((state) => state.reviewOpen)
  const terminalOpen = useAppStore((state) => state.terminalOpen)
  const sidePanel = useAppStore((state) => state.chatSidePanel)
  const diffShortcut = useAppStore((state) => activeShortcuts(state).diff)
  const setSidePanel = useAppStore((state) => state.setChatSidePanel)

  return (
    <nav className="flex w-10 shrink-0 flex-col items-center gap-1 border-l border-border bg-app py-2">
      <RailButton
        icon={<ShieldCheck size={16} />}
        active={reviewOpen}
        onClick={() => useAppStore.getState().toggleReview()}
        title={t('chat.toolbar.reviewPanel')}
      />
      <RailButton
        icon={<FolderTree size={16} />}
        active={sidePanel === 'files'}
        onClick={() => void setSidePanel(sidePanel === 'files' ? null : 'files')}
        title={t('chat.toolbar.fileTree')}
      />
      <RailButton
        icon={<GitCompare size={16} />}
        active={sidePanel === 'diff'}
        onClick={() => void setSidePanel(sidePanel === 'diff' ? null : 'diff')}
        title={diffShortcut
          ? t('settings.shortcuts.actionWithShortcut', { action: t('chat.toolbar.diffViewer'), shortcut: formatShortcut(diffShortcut, window.piDesktop.system.platform) })
          : t('chat.toolbar.diffViewer')}
      />
      <RailButton
        icon={<Terminal size={16} />}
        active={terminalOpen}
        onClick={() => useAppStore.getState().toggleTerminal()}
        title={t('chat.toolbar.terminal')}
      />
    </nav>
  )
}

function RailButton({
  icon,
  active,
  onClick,
  title,
}: {
  icon: React.ReactNode
  active: boolean
  onClick: () => void
  title: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={title}
      className={clsx(
        'relative flex h-8 w-8 items-center justify-center rounded-md transition-colors',
        active
          ? 'bg-card text-primary before:absolute before:-right-1 before:top-1.5 before:bottom-1.5 before:w-0.5 before:rounded-full before:bg-accent'
          : 'text-dim hover:bg-highlight hover:text-secondary'
      )}
      title={title}
    >
      {icon}
    </button>
  )
}
