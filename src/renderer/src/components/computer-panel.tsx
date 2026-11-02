import { Monitor, X, ExternalLink, RefreshCw } from 'lucide-react'
import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../store'
import type { ComputerBackend } from '../../../shared/ipc-contracts'

// Webview n'est pas typé dans React, on le cast
const Webview = 'webview' as unknown as React.FC<
  React.DetailedHTMLProps<
    React.HTMLAttributes<HTMLElement> & {
      src?: string
      partition?: string
      allowpopups?: string
      webpreferences?: string
    },
    HTMLElement
  >
>

const BACKEND_OPTIONS: { value: ComputerBackend; labelKey: string; labelFallback: string }[] = [
  { value: 'main-os', labelKey: 'computer.backendMainOs', labelFallback: 'Main OS' },
  { value: 'proxmox-vm', labelKey: 'computer.backendProxmoxVm', labelFallback: 'Proxmox VM' },
  { value: 'docker-host', labelKey: 'computer.backendDockerHost', labelFallback: 'Docker (this PC)' },
  { value: 'docker-vm', labelKey: 'computer.backendDockerVm', labelFallback: 'Docker (CUA VM)' },
  { value: 'auto', labelKey: 'computer.backendAuto', labelFallback: 'Auto (Jev)' },
]

/**
 * Panneau Computer : affiche le viewer Cua dans un webview Electron isolé.
 * L'URL est fournie par le processus principal via IPC.
 */
export function ComputerPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const computerViewerUrl = useAppStore((state) => state.computerViewerUrl)
  const computerSessionId = useAppStore((state) => state.computerSessionId)
  const computerError = useAppStore((state) => state.computerError)
  const computerBackend = useAppStore((state) => state.computerBackend)
  const computerSessionBackend = useAppStore((state) => state.computerSessionBackend)
  const computerJudgmentReason = useAppStore((state) => state.computerJudgmentReason)
  const closeComputerPanel = useAppStore((state) => state.closeComputerPanel)
  const refreshComputerViewer = useAppStore((state) => state.refreshComputerViewer)
  const setComputerBackend = useAppStore((state) => state.setComputerBackend)
  const [reloadKey, setReloadKey] = useState(0)

  const backendLabel = (backend: ComputerBackend): string => {
    const option = BACKEND_OPTIONS.find((candidate) => candidate.value === backend)
    return option ? t(option.labelKey, option.labelFallback) : backend
  }

  // Recharger le webview quand l'URL change
  useEffect(() => {
    setReloadKey((k) => k + 1)
  }, [computerViewerUrl])

  const handleOpenExternal = () => {
    if (computerViewerUrl) {
      window.piDesktop.system.openExternal(computerViewerUrl)
    }
  }

  const handleRefresh = () => {
    refreshComputerViewer()
    setReloadKey((k) => k + 1)
  }

  return (
    <div className="flex h-full flex-col bg-app">
      {/* En-tête */}
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <Monitor size={16} className="text-accent" />
          <span className="text-sm font-medium text-primary">
            {t('computer.title', 'Computer')}
          </span>
          <select
            aria-label={t('computer.backendAria', 'Session backend')}
            value={computerBackend}
            onChange={(e) => {
              void setComputerBackend(e.target.value as ComputerBackend)
            }}
            className="h-6 max-w-[9rem] rounded border border-border-strong bg-surface px-1 text-xs text-primary hover:border-border-strong-hover focus:border-focus focus:outline-none"
          >
            {BACKEND_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.labelKey, option.labelFallback)}
              </option>
            ))}
          </select>
          {computerSessionId && (
            <span className="text-xs text-muted">
              #{computerSessionId.slice(0, 8)}
              {computerBackend === 'auto' && computerSessionBackend && (
                <span className="text-faint">
                  {' · '}
                  {backendLabel(computerSessionBackend)}
                  {computerJudgmentReason && ` — ${computerJudgmentReason}`}
                </span>
              )}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleRefresh}
            className="flex h-6 w-6 items-center justify-center rounded text-faint hover:bg-highlight hover:text-secondary"
            title={t('computer.refresh', 'Refresh viewer')}
          >
            <RefreshCw size={12} />
          </button>
          <button
            onClick={handleOpenExternal}
            disabled={!computerViewerUrl}
            className="flex h-6 w-6 items-center justify-center rounded text-faint hover:bg-highlight hover:text-secondary disabled:opacity-50"
            title={t('computer.openExternal', 'Open in browser')}
          >
            <ExternalLink size={12} />
          </button>
          <button
            onClick={closeComputerPanel}
            className="flex h-6 w-6 items-center justify-center rounded text-faint hover:bg-highlight hover:text-secondary"
            title={t('computer.close', 'Close panel')}
          >
            <X size={12} />
          </button>
        </div>
      </div>

      {/* Contenu */}
      <div className="flex-1 overflow-hidden">
        {computerError ? (
          <div className="flex h-full items-center justify-center p-4">
            <div className="max-w-md text-center">
              <Monitor size={48} className="mx-auto mb-4 text-error" />
              <p className="mb-2 text-sm font-medium text-primary">
                {t('computer.error', 'Unable to load computer viewer')}
              </p>
              <p className="text-xs text-muted">{computerError}</p>
              <button
                onClick={handleRefresh}
                className="mt-4 rounded bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg hover:bg-accent/90"
              >
                {t('computer.retry', 'Retry')}
              </button>
            </div>
          </div>
        ) : computerViewerUrl ? (
          <Webview
            key={reloadKey}
            src={computerViewerUrl}
            partition="persist:cua-viewer"
            className="flex-1"
            style={{ display: 'flex', width: '100%', height: '100%', border: 'none' }}
            webpreferences="contextIsolation=yes,nodeIntegration=no,sandbox=yes"
          />
        ) : (
          <div className="flex h-full items-center justify-center p-4">
            <div className="max-w-md text-center">
              <Monitor size={48} className="mx-auto mb-4 text-muted" />
              <p className="mb-2 text-sm font-medium text-primary">
                {t('computer.noSession', 'No active computer session')}
              </p>
              <p className="text-xs text-muted">
                {t(
                  'computer.noSessionHint',
                  'Create a Cua Space to start using the computer.'
                )}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
