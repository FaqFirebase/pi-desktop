import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Terminal as XTerm, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { useAppStore } from '../store'
import { useAppliedThemeId } from '../hooks'
import { DEFAULT_SETTINGS } from '../../../shared/default-settings'
import { clsx } from 'clsx'
import {
  Terminal as TerminalIcon,
  X,
  Maximize2,
  Minimize2,
  Trash2,
} from 'lucide-react'

// Build the xterm color theme from the active app theme's CSS variables so the
// terminal matches whichever theme (dark/light/nord/gruvbox/breeze) is applied.
// Falls back to the dark palette if a variable is missing.
function buildTerminalTheme(): ITheme {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string): string => {
    const value = css.getPropertyValue(name).trim()
    return value || fallback
  }

  const bg = v('--color-app', '#0a0a0a')
  const fg = v('--color-primary', '#d4d4d4')

  return {
    background: bg,
    foreground: fg,
    cursor: fg,
    selectionBackground: v('--cm-selection-bg', '#3b82f666'),
    black: bg,
    red: v('--color-error', '#ef4444'),
    green: v('--color-success', '#22c55e'),
    yellow: v('--color-warning', '#eab308'),
    blue: v('--color-accent', '#3b82f6'),
    magenta: v('--cm-keyword', '#a855f7'),
    cyan: v('--cm-link', '#06b6d4'),
    white: fg,
    brightBlack: v('--color-muted', '#525252'),
    brightRed: v('--color-error', '#f87171'),
    brightGreen: v('--color-success', '#4ade80'),
    brightYellow: v('--color-warning', '#facc15'),
    brightBlue: v('--color-accent', '#60a5fa'),
    brightMagenta: v('--cm-keyword', '#c084fc'),
    brightCyan: v('--cm-link', '#22d3ee'),
    brightWhite: v('--color-secondary', '#ffffff'),
  }
}

export function TerminalPanel(): React.JSX.Element {
  const workspaces = useAppStore((state) => state.workspaces)
  const activeId = useAppStore((state) => state.activeWorkspace?.id)
  const open = useAppStore((state) => state.terminalOpen)
  return <>{workspaces.map((workspace) => (
    <ProjectTerminal key={`${workspace.id}:${workspace.path}`} workspaceId={workspace.id}
      visible={open && workspace.id === activeId} />
  ))}</>
}

// Lazy creation, then keep xterm (including scrollback) mounted until project closure.
function ProjectTerminal({ workspaceId, visible }: { workspaceId: string; visible: boolean }): React.JSX.Element | null {
  const [opened, setOpened] = useState(visible)
  useEffect(() => {
    if (visible) setOpened(true)
  }, [visible])
  return opened || visible ? <TerminalSession workspaceId={workspaceId} visible={visible} /> : null
}

function TerminalSession({ workspaceId, visible }: { workspaceId: string; visible: boolean }): React.JSX.Element {
  const { t } = useTranslation()
  const toggleTerminal = useAppStore((state) => state.toggleTerminal)
  const appliedThemeId = useAppliedThemeId()

  const [maximized, setMaximized] = useState(false)
  const [shellLabel, setShellLabel] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    if (!containerRef.current) return

    const terminal = new XTerm({
      cursorBlink: true,
      convertEol: true,
      fontFamily: "'JetBrains Mono Variable', 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      // Use the Terminal Font Size setting (or the unsaved settings draft),
      // read once at creation. Falls back to the default.
      fontSize:
        useAppStore.getState().settingsDraft.terminalFontSize ??
        useAppStore.getState().settings?.terminalFontSize ??
        DEFAULT_SETTINGS.terminalFontSize,
      theme: buildTerminalTheme(),
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.loadAddon(new WebLinksAddon())
    terminal.open(containerRef.current)

    terminalRef.current = terminal
    fitRef.current = fit

    const fitAndResize = () => {
      if (!containerRef.current?.clientWidth || !containerRef.current?.clientHeight) return
      fit.fit()
      void window.piDesktop.terminal.resize(workspaceId, terminal.cols, terminal.rows).catch(() => {})
    }

    const dataDisposable = terminal.onData((data) => {
      void window.piDesktop.terminal.input(workspaceId, data).catch(() => {})
    })
    const outputCleanup = window.piDesktop.terminal.onData((event) => {
      if (event.workspaceId === workspaceId) terminal.write(event.data)
    })
    const exitCleanup = window.piDesktop.terminal.onExit((event) => {
      if (event.workspaceId !== workspaceId) return
      terminal.writeln('')
      terminal.writeln(`[process exited with code ${event.exitCode}]`)
    })

    let disposed = false
    const timer = window.setTimeout(async () => {
      fit.fit()
      try {
        const result = await window.piDesktop.terminal.start(workspaceId, {
          cols: terminal.cols,
          rows: terminal.rows,
        })
        if (disposed) return
        setShellLabel(result.shell.split(/[\\/]/).pop() ?? result.shell)
      } catch (err) {
        if (disposed) return
        terminal.writeln(`Failed to start terminal: ${err instanceof Error ? err.message : String(err)}`)
      }
      if (containerRef.current?.clientWidth) terminal.focus()
    }, 0)

    const observer = new ResizeObserver(fitAndResize)
    observer.observe(containerRef.current)

    return () => {
      disposed = true
      window.clearTimeout(timer)
      observer.disconnect()
      dataDisposable.dispose()
      outputCleanup()
      exitCleanup()
      void window.piDesktop.terminal.stop(workspaceId).catch(() => {})
      terminal.dispose()
      terminalRef.current = null
      fitRef.current = null
    }
  }, [workspaceId])

  useEffect(() => {
    if (!visible) return
    const timer = window.setTimeout(() => {
      if (!containerRef.current?.clientWidth) return
      fitRef.current?.fit()
      const terminal = terminalRef.current
      if (terminal) {
        void window.piDesktop.terminal.resize(workspaceId, terminal.cols, terminal.rows).catch(() => {})
        terminal.focus()
      }
    }, 0)
    return () => window.clearTimeout(timer)
  }, [visible, maximized, workspaceId])

  // Recolor the live terminal when the app theme changes, without recreating it.
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = buildTerminalTheme()
    }
  }, [appliedThemeId])

  return (
    <div
      style={visible ? undefined : { display: 'none' }}
      className={clsx(
        'flex flex-col border-t border-border bg-app',
        maximized ? 'flex-1' : 'h-64'
      )}
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <div className="flex items-center gap-2">
          <TerminalIcon size={14} className="text-dim" />
          <span className="text-xs text-muted">{t('terminal.title')}</span>
          <span className="text-[10px] text-faint">{shellLabel ?? t('terminal.title')}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => terminalRef.current?.clear()}
            className="rounded p-1 text-faint hover:text-muted transition-colors"
            title={t('terminal.clearTitle')}
            aria-label={t('terminal.clearAriaLabel')}
          >
            <Trash2 size={12} />
          </button>
          <button
            onClick={() => setMaximized(!maximized)}
            className="rounded p-1 text-faint hover:text-muted transition-colors"
            title={maximized ? t('terminal.restoreLabel') : t('terminal.maximizeLabel')}
            aria-label={maximized ? t('terminal.restoreLabel') : t('terminal.maximizeLabel')}
          >
            {maximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          </button>
          <button
            onClick={toggleTerminal}
            className="rounded p-1 text-faint hover:text-muted transition-colors"
            title={t('terminal.closeTitle')}
            aria-label={t('terminal.closeTitle')}
          >
            <X size={12} />
          </button>
        </div>
      </div>

      <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden p-2" />
    </div>
  )
}
