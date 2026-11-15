import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, RotateCw } from 'lucide-react'
import { PI_DESKTOP_PRODUCT_NAME } from '../../../shared/product-name'
import { currentRendererErrorContext, formatCrashDetails } from '../utils/renderer-error-report'

/** Same feedback time as CopyButton. */
const COPIED_FEEDBACK_MS = 1500

/** The root error boundary's fallback: the whole window, with Reload and Copy details. */
export function AppCrashScreen({ error, componentStack }: { error: Error; componentStack: string | null }): React.JSX.Element {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  const copyDetails = (): void => {
    const details = formatCrashDetails({ error, componentStack, appVersion: __APP_VERSION__, view: currentRendererErrorContext().view })
    void navigator.clipboard.writeText(details).catch(() => undefined)
    setCopied(true)
    setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS)
  }

  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-app px-6 text-center text-primary">
      <AlertTriangle size={36} className="text-warning" />
      <h1 className="text-base font-semibold">{t('app.crashScreen.title')}</h1>
      <p className="max-w-md text-sm text-secondary">{t('app.crashScreen.message', { product: PI_DESKTOP_PRODUCT_NAME })}</p>
      <div className="flex items-center gap-3">
        <button
          onClick={() => window.location.reload()}
          className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs text-white hover:bg-accent-hover transition-colors"
        >
          <RotateCw size={12} />
          {t('app.crashScreen.reload')}
        </button>
        <button
          onClick={copyDetails}
          className="rounded-md px-3 py-1.5 text-xs text-secondary hover:bg-surface-hover hover:text-primary transition-colors"
        >
          {copied ? t('common.copied') : t('app.crashScreen.copyDetails')}
        </button>
      </div>
    </div>
  )
}
