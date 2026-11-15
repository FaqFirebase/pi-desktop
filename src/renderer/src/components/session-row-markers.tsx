import { useTranslation } from 'react-i18next'
import { clsx } from 'clsx'
import { Clock, Pin } from 'lucide-react'

const SESSION_ROW_ICON_SIZE = 12

/** A session row's leading icon: a pin for a pinned session, else the clock. */
export function SessionRowIcon({ pinned, className }: { pinned: boolean; className?: string }): React.JSX.Element {
  const { t } = useTranslation()
  const classes = clsx('shrink-0', className)
  return pinned ? (
    <Pin size={SESSION_ROW_ICON_SIZE} className={classes} aria-label={t('sessions.pinnedBadge')}>
      <title>{t('sessions.pinnedBadge')}</title>
    </Pin>
  ) : (
    <Clock size={SESSION_ROW_ICON_SIZE} className={classes} />
  )
}

/** The dot of a session whose last turn ended while it was not on screen. */
export function SessionUnreadDot(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <span
      role="img"
      aria-label={t('sessions.unreadDot')}
      title={t('sessions.unreadDot')}
      className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
    />
  )
}
