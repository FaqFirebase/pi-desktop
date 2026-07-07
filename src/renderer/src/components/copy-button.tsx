import { useState } from 'react'
import { clsx } from 'clsx'
import { Copy, Check } from 'lucide-react'

export function CopyButton({
  text,
  className,
}: {
  text: string
  className?: string
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation()
    void navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <button
      onClick={handleCopy}
      title={copied ? 'Copied' : 'Copy'}
      aria-label={copied ? 'Copied' : 'Copy'}
      className={clsx(
        'z-10 rounded p-1 text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-200',
        className
      )}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  )
}
