import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { clsx } from 'clsx'
import { ArrowLeft, ArrowRight, Crosshair, ExternalLink, RotateCw, X } from 'lucide-react'
import { useAppStore } from '../store'
import { createStaleGuard } from '../utils/stale-guard'
import { buildPickAttachments, fitsAttachmentLimit, pngBase64FromDataUrl } from '../utils/browser-pick-attachments'
import { BROWSER_PANE_PARTITION } from '../../../shared/preview-partitions'
import { nextZoomLevel, normalizeAddressInput, type BrowserPaneGuestEvent } from '../../../shared/browser-pane'
import { BROWSER_PICK_CHANNELS, captureRectForPick, isAcceptedPickMessage, parseBrowserPick } from '../../../shared/browser-pick'
import { Webview, type WebviewElement } from './webview-tag'

// Chromium's net error for a load that a newer navigation replaced; not a failure to show.
const ERR_ABORTED = -3
const ESCAPE_KEY = 'Escape'
// Present (empty) means on: pop-ups reach main's window-open handler, which
// loads a clicked one in the pane and never opens a window.
const ALLOW_POPUPS = ''

type PaneError = { kind: 'invalidAddress' } | { kind: 'loadFailed'; url: string }
type PaneNotice = 'downloadRefused' | 'pickImageTooLarge'

/** The Browser view of the chat side slot: one page per workspace, and the element picker. */
export function BrowserPane({ onClose }: { onClose: () => void }): React.JSX.Element {
  const workspace = useAppStore((state) => state.activeWorkspace)
  const workspacePath = workspace?.path ?? null
  const savedUrl = useAppStore((state) => (workspacePath ? state.settings?.browserPaneUrls[workspacePath] : undefined) ?? null)
  // Keyed by workspace: each workspace gets its own guest page and pane state.
  return (
    <BrowserPaneView
      key={workspacePath ?? ''}
      workspaceId={workspace?.id ?? ''}
      workspacePath={workspacePath}
      initialUrl={savedUrl}
      onClose={onClose}
    />
  )
}

function BrowserPaneView({
  workspaceId,
  workspacePath,
  initialUrl,
  onClose,
}: {
  workspaceId: string
  workspacePath: string | null
  initialUrl: string | null
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const webviewRef = useRef<WebviewElement>(null)
  const addressRef = useRef<HTMLInputElement>(null)
  const readyRef = useRef(false)
  const pickGuard = useRef(createStaleGuard()).current
  // Set once from the saved page, then only by an address entered before the
  // guest is ready. Never from navigation, which would reload the page.
  const [src, setSrc] = useState<string | null>(initialUrl)
  const [address, setAddress] = useState(initialUrl ?? '')
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState<PaneError | null>(null)
  const [notice, setNotice] = useState<PaneNotice | null>(null)

  const readyWebview = useCallback((): WebviewElement | null => {
    const webview = webviewRef.current
    return webview && readyRef.current ? webview : null
  }, [])

  const setPickMode = useCallback((on: boolean) => {
    readyWebview()?.send(on ? BROWSER_PICK_CHANNELS.start : BROWSER_PICK_CHANNELS.stop)
    setPicking(on)
  }, [readyWebview])

  const stagePick = useCallback(async (payload: unknown) => {
    const webview = webviewRef.current
    const pick = parseBrowserPick(payload)
    if (!webview || !pick) return
    const isCurrent = pickGuard.begin()
    const rect = captureRectForPick(pick, webview.getZoomFactor())
    let base64: string | null = null
    if (rect) {
      let image: Electron.NativeImage
      try {
        image = await webview.capturePage(rect)
      } catch (captureError) {
        // The pane closed or switched workspace during the capture.
        if (!isCurrent()) return
        throw captureError
      }
      base64 = pngBase64FromDataUrl(image.toDataURL())
    }
    if (!isCurrent()) return
    if (base64 && !fitsAttachmentLimit(base64)) {
      base64 = null
      setNotice('pickImageTooLarge')
    }
    // Only stages composer chips; nothing is sent until the user presses Send.
    useAppStore.getState().stagePickedAttachments(workspaceId, buildPickAttachments(pick, base64, Date.now()))
  }, [pickGuard, workspaceId])

  // A pick still capturing when the pane goes away is dropped.
  useEffect(() => () => void pickGuard.begin(), [pickGuard])

  const hasWebview = src !== null
  useEffect(() => {
    const webview = webviewRef.current
    if (!webview) return
    const updateHistory = (): void => {
      setCanGoBack(webview.canGoBack())
      setCanGoForward(webview.canGoForward())
    }
    const onDomReady = (): void => {
      readyRef.current = true
    }
    const onNavigate = (event: Electron.DidNavigateEvent): void => {
      setAddress(event.url)
      setError(null)
      setNotice(null)
      setPicking(false)
      updateHistory()
      if (workspacePath) void useAppStore.getState().saveBrowserPaneUrl(workspacePath, event.url)
    }
    const onNavigateInPage = (event: Electron.DidNavigateInPageEvent): void => {
      if (!event.isMainFrame) return
      setAddress(event.url)
      updateHistory()
    }
    const onFailLoad = (event: Electron.DidFailLoadEvent): void => {
      if (event.isMainFrame && event.errorCode !== ERR_ABORTED) setError({ kind: 'loadFailed', url: event.validatedURL })
    }
    const onIpcMessage = (event: Electron.IpcMessageEvent): void => {
      if (!isAcceptedPickMessage(event.channel, picking)) return
      setPicking(false)
      if (event.channel === BROWSER_PICK_CHANNELS.picked) void stagePick(event.args[0])
    }
    webview.addEventListener('dom-ready', onDomReady)
    webview.addEventListener('did-navigate', onNavigate)
    webview.addEventListener('did-navigate-in-page', onNavigateInPage)
    webview.addEventListener('did-fail-load', onFailLoad)
    webview.addEventListener('ipc-message', onIpcMessage)
    return () => {
      webview.removeEventListener('dom-ready', onDomReady)
      webview.removeEventListener('did-navigate', onNavigate)
      webview.removeEventListener('did-navigate-in-page', onNavigateInPage)
      webview.removeEventListener('did-fail-load', onFailLoad)
      webview.removeEventListener('ipc-message', onIpcMessage)
    }
  }, [hasWebview, workspacePath, stagePick, picking])

  // Pane keys pressed while the page has focus: main catches them and tells us.
  useEffect(() => window.piDesktop.browserPane.onGuestEvent((event: BrowserPaneGuestEvent) => {
    const webview = readyWebview()
    if (!webview || event.webContentsId !== webview.getWebContentsId()) return
    if (event.kind === 'download-refused') {
      setNotice('downloadRefused')
      return
    }
    if (event.action === 'reload') webview.reload()
    else if (event.action === 'focusAddress') {
      addressRef.current?.focus()
      addressRef.current?.select()
    } else webview.setZoomLevel(nextZoomLevel(webview.getZoomLevel(), event.action))
  }), [readyWebview])

  const submitAddress = (event: React.FormEvent): void => {
    event.preventDefault()
    const url = normalizeAddressInput(address)
    if (!url) {
      setError({ kind: 'invalidAddress' })
      return
    }
    setError(null)
    const webview = readyWebview()
    // A failed load shows through did-fail-load; the promise adds nothing.
    if (webview) webview.loadURL(url).catch(() => {})
    else setSrc(url)
  }

  const openExternal = (): void => {
    const url = readyWebview()?.getURL()
    if (url) void window.piDesktop.system.openExternal(url)
  }

  const onPaneKeyDown = (event: React.KeyboardEvent): void => {
    if (picking && event.key === ESCAPE_KEY) setPickMode(false)
  }

  return (
    <div className="flex h-full min-h-0 flex-col" onKeyDown={onPaneKeyDown}>
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        <ToolbarButton title={t('browserPane.back')} disabled={!canGoBack} onClick={() => readyWebview()?.goBack()}>
          <ArrowLeft size={13} />
        </ToolbarButton>
        <ToolbarButton title={t('browserPane.forward')} disabled={!canGoForward} onClick={() => readyWebview()?.goForward()}>
          <ArrowRight size={13} />
        </ToolbarButton>
        <ToolbarButton title={t('browserPane.reload')} disabled={!hasWebview} onClick={() => readyWebview()?.reload()}>
          <RotateCw size={13} />
        </ToolbarButton>
        <form className="min-w-0 flex-1" onSubmit={submitAddress}>
          <input
            ref={addressRef}
            value={address}
            onChange={(event) => {
              setAddress(event.target.value)
              if (error?.kind === 'invalidAddress') setError(null)
            }}
            aria-label={t('browserPane.addressLabel')}
            placeholder={t('browserPane.addressPlaceholder')}
            spellCheck={false}
            className="h-6 w-full rounded border border-border bg-app px-2 text-xs text-primary outline-none placeholder:text-faint focus:border-border-strong"
          />
        </form>
        <ToolbarButton title={t('browserPane.openExternal')} disabled={!hasWebview} onClick={openExternal}>
          <ExternalLink size={13} />
        </ToolbarButton>
        <ToolbarButton
          title={picking ? t('browserPane.stopPicking') : t('browserPane.pick')}
          disabled={!hasWebview}
          active={picking}
          onClick={() => setPickMode(!picking)}
        >
          <Crosshair size={13} />
        </ToolbarButton>
        <ToolbarButton title={t('browserPane.close')} onClick={onClose}>
          <X size={13} />
        </ToolbarButton>
      </div>
      {error && (
        <div className="shrink-0 border-b border-border px-3 py-1.5 text-xs text-error">
          {error.kind === 'invalidAddress' ? t('browserPane.invalidAddress') : t('browserPane.loadFailed', { url: error.url })}
        </div>
      )}
      {notice && (
        <div className="shrink-0 border-b border-border px-3 py-1.5 text-xs text-dim">
          {notice === 'downloadRefused' ? t('browserPane.downloadRefused') : t('browserPane.pickImageTooLarge')}
        </div>
      )}
      {src === null ? (
        <p className="px-4 py-6 text-center text-xs text-dim">{t('browserPane.emptyHint')}</p>
      ) : (
        <Webview
          ref={webviewRef}
          src={src}
          partition={BROWSER_PANE_PARTITION}
          allowpopups={ALLOW_POPUPS}
          className="flex-1"
          style={{ display: 'flex', width: '100%', height: '100%', border: 'none' }}
        />
      )}
    </div>
  )
}

function ToolbarButton({
  title,
  onClick,
  disabled = false,
  active,
  children,
}: {
  title: string
  onClick: () => void
  disabled?: boolean
  /** Set only on a toggle button: it is pressed while true. */
  active?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      title={title}
      aria-label={title}
      className={clsx(
        'shrink-0 rounded p-1 transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        active ? 'bg-card text-primary' : 'text-dim hover:text-secondary',
      )}
    >
      {children}
    </button>
  )
}
