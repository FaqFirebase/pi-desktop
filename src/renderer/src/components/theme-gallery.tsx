import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import clsx from 'clsx'
import { X, Check, User, ChevronLeft } from 'lucide-react'
import type { GalleryTheme, UserThemeRecord } from '../../../shared/ipc-contracts'
import { resolveThemeVars } from '../../../shared/theme/resolve'

// How many cards render before "Show more" reveals the next batch. Keeps a
// large index responsive — each card mounts a live-preview subtree.
const GALLERY_PAGE_SIZE = 12

interface ThemeGalleryProps {
  onClose: () => void
  // Called after a gallery theme is installed so the panel can register,
  // apply, and select it (installs go through the same validated,
  // SSRF-guarded path as manual URL installs).
  onInstalled: (theme: UserThemeRecord) => void
}

type LoadState = 'loading' | 'ready' | 'error'

// Scopes a theme's full resolved variable set to one preview card. The card's
// children read var(--color-*) exactly like the real app does, so the preview
// uses the same derivation pipeline (color-mix and all) as an actual install
// — no screenshots or approximations involved.
function previewStyle(theme: NonNullable<GalleryTheme['theme']>): CSSProperties {
  return resolveThemeVars(theme) as CSSProperties
}

// A miniature of the app's layout: sidebar, chat surface with a bubble, a
// syntax-highlighted code line, and status dots — enough to judge both the UI
// colors AND the code-highlighting palette (which matters for a coding app) at
// a glance. `detail` renders a taller version for the expanded card view.
function ThemePreview({
  theme,
  detail = false,
}: {
  theme: NonNullable<GalleryTheme['theme']>
  detail?: boolean
}): React.JSX.Element {
  return (
    <div
      style={{ ...previewStyle(theme), borderColor: 'var(--color-border)' }}
      className={clsx(
        'pointer-events-none flex select-none overflow-hidden rounded-md border',
        detail ? 'h-52' : 'h-28'
      )}
      aria-hidden
    >
      <div style={{ backgroundColor: 'var(--color-surface)', borderColor: 'var(--color-border)' }} className="flex w-1/4 flex-col gap-1.5 border-r p-2">
        <div style={{ backgroundColor: 'var(--color-accent)' }} className="h-2 w-3/4 rounded-sm" />
        <div style={{ backgroundColor: 'var(--color-muted)' }} className="h-1.5 w-full rounded-sm opacity-60" />
        <div style={{ backgroundColor: 'var(--color-muted)' }} className="h-1.5 w-5/6 rounded-sm opacity-40" />
        <div style={{ backgroundColor: 'var(--color-muted)' }} className="h-1.5 w-4/6 rounded-sm opacity-40" />
      </div>
      <div style={{ backgroundColor: 'var(--color-app)' }} className="flex flex-1 flex-col justify-between p-2">
        <div className="flex flex-col gap-1.5">
          <div style={{ backgroundColor: 'var(--color-card)' }} className="h-4 w-3/4 self-start rounded-sm" />
          <div style={{ backgroundColor: 'var(--color-accent)' }} className="h-4 w-2/3 self-end rounded-sm opacity-90" />
        </div>
        {/* Code sample rendered from the theme's own --cm-* syntax palette. */}
        <div
          style={{ backgroundColor: 'var(--color-md-pre-bg)' }}
          className={clsx(
            'flex items-center gap-1.5 rounded-sm px-1.5 py-1 font-mono leading-none',
            detail ? 'text-[10px]' : 'text-[7px]'
          )}
        >
          <span style={{ color: 'var(--cm-keyword)' }}>const</span>
          <span style={{ color: 'var(--cm-variable)' }}>theme</span>
          <span style={{ color: 'var(--cm-operator)' }}>=</span>
          <span style={{ color: 'var(--cm-string)' }}>&quot;pi&quot;</span>
          <span style={{ color: 'var(--cm-comment)' }}>// syntax</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span style={{ backgroundColor: 'var(--color-success)' }} className="h-2 w-2 rounded-full" />
          <span style={{ backgroundColor: 'var(--color-warning)' }} className="h-2 w-2 rounded-full" />
          <span style={{ backgroundColor: 'var(--color-error)' }} className="h-2 w-2 rounded-full" />
          <span
            style={{ backgroundColor: 'var(--color-surface)', color: 'var(--color-primary)' }}
            className="ml-auto rounded-sm px-1.5 py-0.5 text-[8px] leading-tight"
          >
            Aa
          </span>
        </div>
      </div>
    </div>
  )
}

export function ThemeGallery({ onClose, onInstalled }: ThemeGalleryProps): React.JSX.Element {
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [themes, setThemes] = useState<GalleryTheme[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [installingUrl, setInstallingUrl] = useState<string | null>(null)
  const [installedUrls, setInstalledUrls] = useState<Set<string>>(new Set())
  const [installError, setInstallError] = useState<string | null>(null)
  const [visibleCount, setVisibleCount] = useState(GALLERY_PAGE_SIZE)
  const [detail, setDetail] = useState<GalleryTheme | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.piDesktop.themes.gallery().then((result) => {
      if (cancelled) return
      if (result.ok) {
        setThemes(result.themes)
        setLoadState('ready')
      } else {
        setLoadError(result.error)
        setLoadState('error')
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // Escape backs out of the detail view first, then closes the modal.
        if (detail) setDetail(null)
        else onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, detail])

  const install = async (theme: GalleryTheme): Promise<void> => {
    setInstallingUrl(theme.url)
    setInstallError(null)
    const result = await window.piDesktop.themes.installFromUrl(theme.url)
    setInstallingUrl(null)
    if (result.ok) {
      setInstalledUrls((prev) => new Set(prev).add(theme.url))
      onInstalled(result.theme)
    } else if (!('canceled' in result)) {
      setInstallError(result.error)
    }
  }

  const installButtonLabel = (theme: GalleryTheme): React.JSX.Element | string => {
    if (installedUrls.has(theme.url)) {
      return (
        <span className="flex items-center gap-1">
          <Check size={14} /> Installed
        </span>
      )
    }
    return installingUrl === theme.url ? 'Installing…' : 'Install'
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-lg border border-border-strong bg-surface shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            {detail && (
              <button
                onClick={() => setDetail(null)}
                aria-label="Back to all themes"
                className="rounded p-1 text-dim hover:bg-surface-hover hover:text-primary transition-colors"
              >
                <ChevronLeft size={16} />
              </button>
            )}
            <div>
              <h3 className="text-base font-semibold text-primary">
                {detail ? detail.name : 'Community themes'}
              </h3>
              <p className="text-xs text-dim">
                {detail
                  ? 'Live preview from the theme’s real colors'
                  : 'From the pi-desktop-themes gallery — click a theme for details'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-dim hover:bg-surface-hover hover:text-primary transition-colors"
          >
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {detail ? (
            <ThemeDetail
              theme={detail}
              installLabel={installButtonLabel(detail)}
              installDisabled={installingUrl === detail.url || installedUrls.has(detail.url)}
              onInstall={() => void install(detail)}
            />
          ) : (
            <>
              {loadState === 'loading' && <p className="text-sm text-muted">Loading themes…</p>}
              {loadState === 'error' && (
                <p className="text-sm text-error">Could not load the gallery: {loadError}</p>
              )}
              {loadState === 'ready' && themes.length === 0 && (
                <p className="text-sm text-muted">No themes are available yet.</p>
              )}
              {loadState === 'ready' && themes.length > 0 && (
                <>
                  <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {themes.slice(0, visibleCount).map((theme) => (
                      <li
                        key={theme.url}
                        className="relative flex flex-col gap-2 rounded-md border border-border bg-app/40 p-3 transition-colors hover:border-border-strong"
                      >
                        {/* Full-card overlay button opens the detail view; the
                            Install button below stacks above it, so both are
                            real, keyboard-reachable controls with no nesting. */}
                        <button
                          type="button"
                          onClick={() => setDetail(theme)}
                          aria-label={`View ${theme.name} details`}
                          className="absolute inset-0 z-10 rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
                        />
                        {theme.theme && <ThemePreview theme={theme.theme} />}
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-sm font-medium text-primary">{theme.name}</span>
                              <span className="shrink-0 rounded-sm bg-card px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                                {theme.kind}
                              </span>
                            </div>
                            {theme.author && (
                              <div className="mt-0.5 flex items-center gap-1 text-xs text-dim">
                                <User size={10} />
                                <span className="truncate">{theme.author}</span>
                              </div>
                            )}
                          </div>
                          <button
                            type="button"
                            onClick={() => void install(theme)}
                            disabled={installingUrl === theme.url || installedUrls.has(theme.url)}
                            className="relative z-20 shrink-0 rounded-md border border-border-strong px-3 py-1 text-sm text-muted hover:bg-surface-hover transition-colors disabled:pointer-events-none disabled:opacity-60"
                          >
                            {installButtonLabel(theme)}
                          </button>
                        </div>
                        {theme.description && (
                          <p className="line-clamp-2 text-xs leading-relaxed text-muted">{theme.description}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                  {visibleCount < themes.length && (
                    <div className="mt-4 flex justify-center">
                      <button
                        onClick={() => setVisibleCount((n) => n + GALLERY_PAGE_SIZE)}
                        className="rounded-md border border-border-strong px-4 py-1.5 text-sm text-muted hover:bg-surface-hover transition-colors"
                      >
                        Show more ({themes.length - visibleCount})
                      </button>
                    </div>
                  )}
                </>
              )}
              {installError && <p className="mt-3 text-xs text-error">{installError}</p>}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// Expanded view for one theme: a large live preview, full metadata, the
// author screenshot if present (lazily fetched as a data URI), and Install.
function ThemeDetail({
  theme,
  installLabel,
  installDisabled,
  onInstall,
}: {
  theme: GalleryTheme
  installLabel: React.JSX.Element | string
  installDisabled: boolean
  onInstall: () => void
}): React.JSX.Element {
  const [shot, setShot] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [shotUri, setShotUri] = useState<string | null>(null)

  useEffect(() => {
    if (!theme.screenshotUrl) return
    let cancelled = false
    setShot('loading')
    void window.piDesktop.themes.galleryImage(theme.screenshotUrl).then((result) => {
      if (cancelled) return
      if (result.ok) {
        setShotUri(result.dataUri)
        setShot('ready')
      } else {
        setShot('error')
      }
    })
    return () => {
      cancelled = true
    }
  }, [theme.screenshotUrl])

  return (
    <div className="flex flex-col gap-4">
      {theme.theme && <ThemePreview theme={theme.theme} detail />}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-primary">{theme.name}</span>
            <span className="rounded-sm bg-card px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
              {theme.kind}
            </span>
          </div>
          {theme.author && (
            <div className="mt-1 flex items-center gap-1 text-xs text-dim">
              <User size={11} />
              <span>{theme.author}</span>
            </div>
          )}
        </div>
        <button
          onClick={onInstall}
          disabled={installDisabled}
          className="shrink-0 rounded-md border border-border-strong px-4 py-1.5 text-sm text-muted hover:bg-surface-hover transition-colors disabled:opacity-60"
        >
          {installLabel}
        </button>
      </div>
      {theme.description && (
        <p className="text-sm leading-relaxed text-muted">{theme.description}</p>
      )}
      {theme.screenshotUrl && (
        <div>
          <div className="mb-1 text-xs text-dim">Author screenshot</div>
          {shot === 'loading' && <p className="text-xs text-muted">Loading screenshot…</p>}
          {shot === 'error' && <p className="text-xs text-muted">Screenshot could not be loaded.</p>}
          {shot === 'ready' && shotUri && (
            <img
              src={shotUri}
              alt={`Screenshot of ${theme.name}`}
              className="max-h-80 w-full rounded-md border border-border object-contain"
            />
          )}
        </div>
      )}
    </div>
  )
}
