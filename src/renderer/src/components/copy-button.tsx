import { useTranslation } from 'react-i18next'
import { clsx } from 'clsx'
import { Copy, Check } from 'lucide-react'
import { useCopyFeedback } from '../hooks/use-copy-feedback'

export function CopyButton({
  text,
  className,
}: {
  text: string
  className?: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const { copied, copy } = useCopyFeedback()

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation()
    copy(text)
  }

  return (
    <button
      onClick={handleCopy}
      title={copied ? t('common.copied') : t('common.copy')}
      aria-label={copied ? t('common.copied') : t('common.copy')}
      className={clsx(
        'z-10 rounded p-1 text-dim transition-colors hover:bg-surface-hover hover:text-primary',
        className
      )}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  )
}
