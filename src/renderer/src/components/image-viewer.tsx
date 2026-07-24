import { useEffect, useState } from 'react'
import { useAppStore } from '../store'
import { Image as ImageIcon, Loader2, X } from 'lucide-react'

/**
 * Read-only image preview pane, opened when a chat filename link points at an
 * image. Loads via readAttachment (absolute path, works outside the workspace)
 * and renders the base64 payload as a data URL.
 */
export function ImageViewer(): React.JSX.Element | null {
  const target = useAppStore((state) => state.previewTarget)
  const image = target?.kind === 'image' ? target : null
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!image) {
      setDataUrl(null)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)
    setDataUrl(null)

    void (async () => {
      try {
        const result = await window.piDesktop.files.readAttachment(image.path)
        if (cancelled) return
        if (result.kind === 'image') {
          setDataUrl(`data:${result.image.mimeType};base64,${result.image.data}`)
        } else if (/\.svg$/i.test(image.name)) {
          // SVG is read as text; render it directly from its markup.
          setDataUrl(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(result.content)}`)
        } else {
          setError('Not a supported image file')
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to read image')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [image])

  if (!image) return null

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-[var(--color-app)]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <ImageIcon size={14} className="shrink-0 text-dim" />
          <span className="truncate text-xs text-secondary">{image.name}</span>
        </div>
        <button
          onClick={() => useAppStore.getState().setPreviewTarget(null)}
          className="rounded p-1 text-dim hover:text-secondary"
          title="Close image"
        >
          <X size={12} />
        </button>
      </div>

      {/* Content */}
      <div className="flex flex-1 items-center justify-center overflow-auto p-4">
        {loading ? (
          <Loader2 size={20} className="animate-spin text-dim" />
        ) : error ? (
          <div className="text-xs text-error">{error}</div>
        ) : dataUrl ? (
          <img
            src={dataUrl}
            alt={image.name}
            className="max-h-full max-w-full object-contain"
          />
        ) : null}
      </div>
    </div>
  )
}
