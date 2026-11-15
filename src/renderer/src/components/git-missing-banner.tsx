import { useTranslation } from 'react-i18next'
import { AlertTriangle, ExternalLink, RefreshCw, X } from 'lucide-react'
import { clsx } from 'clsx'
import { useAppStore } from '../store'
import { GIT_DOWNLOAD_URL, shouldShowGitBanner } from '../utils/git-availability'

/** Where the banner sits: a card on Home, a one-line strip under the workspace chrome. */
export type GitMissingBannerPlacement = 'home' | 'workspace'

/** Explains a missing or broken git with How to install and Check again; it never installs. */
export function GitMissingBanner({ placement }: { placement: GitMissingBannerPlacement }): React.JSX.Element | null {
  const { t } = useTranslation()
  const availability = useAppStore((s) => s.gitAvailability)
  const dismissed = useAppStore((s) => s.gitBannerDismissed)
  const checking = useAppStore((s) => s.gitCheckRunning)
  const recheck = useAppStore((s) => s.recheckGitAvailability)
  const dismiss = useAppStore((s) => s.dismissGitBanner)
  if (!availability || !shouldShowGitBanner(availability, dismissed)) return null

  const home = placement === 'home'
  const title = availability.status === 'failed' ? t('gitCheck.banner.failedTitle') : t('errors.git.notInstalled')
  const body = availability.status === 'failed'
    ? <span className="font-mono">{availability.detail}</span>
    : t('gitCheck.banner.missingDescription')
  const buttonClass = 'flex shrink-0 items-center gap-1.5 rounded-md bg-warning/20 px-2.5 py-1 text-xs text-warning hover:bg-warning/30 disabled:opacity-50'

  return (
    <div
      role="status"
      className={clsx(
        'flex text-warning bg-warning-bg',
        home
          ? 'mb-6 items-start gap-3 rounded-lg border border-warning-bg px-4 py-3 text-sm'
          : 'shrink-0 items-center gap-3 px-4 py-1.5 text-xs',
      )}
    >
      <AlertTriangle size={home ? 16 : 14} className={clsx('shrink-0', home && 'mt-0.5')} />
      <div className={clsx('min-w-0 flex-1', !home && 'truncate')}>
        <span className="font-medium">{title}</span>
        <span className={clsx('text-warning/80', home ? 'mt-0.5 block' : 'ml-2')}>{body}</span>
      </div>
      <button type="button" onClick={() => window.piDesktop.system.openExternal(GIT_DOWNLOAD_URL)} className={buttonClass}>
        <ExternalLink size={12} />
        {t('gitCheck.banner.howToInstall')}
      </button>
      <button type="button" onClick={() => void recheck()} disabled={checking} className={buttonClass}>
        <RefreshCw size={12} className={clsx(checking && 'animate-spin')} />
        {t('gitCheck.banner.checkAgain')}
      </button>
      <button
        type="button"
        onClick={dismiss}
        className="shrink-0 rounded p-0.5 text-warning/80 hover:bg-warning/20 hover:text-warning"
        aria-label={t('gitCheck.banner.dismissAriaLabel')}
        title={t('common.dismiss')}
      >
        <X size={13} />
      </button>
    </div>
  )
}
