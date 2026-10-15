import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Terminal as XTerm, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { useAppStore } from '../store'
import { useAppliedThemeId } from '../hooks'
import { DEFAULT_SETTINGS } from '../../../shared/default-settings'
import { clsx } from 'clsx'
import { useContextMenu, buildTerminalContextMenu } from './context-menu'
import { isNativeClipboardShortcut, usesCtrlClipboardShortcuts } from './terminal-clipboard'
import { ResizeHandle } from './resize-handle'
import { clampTerminalHeight, DEFAULT_TERMINAL_HEIGHT, MAX_TERMINAL_HEIGHT_RATIO } from '../../../shared/terminal-height'
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

// The Terminal Font Size setting, or the unsaved settings draft while the
// Settings view edits it. Falls back to the default.
function selectTerminalFontSize(state: ReturnType<typeof useAppStore.getState>): number {
  return state.settingsDraft.terminalFontSize ?? state.settings?.terminalFontSize ?? DEFAULT_SETTINGS.terminalFontSize
}

// Fit xterm to its container and send the new size to the pty. Skipped while
// the container is hidden (zero size); the resize observer fits it once shown.
function fitAndResize(workspaceId: string, container: HTMLElement | null, terminal: XTerm, fit: FitAddon): boolean {
  if (!container?.clientWidth || !container.clientHeight) return false
  fit.fit()
  void window.piDesktop.terminal.resize(workspaceId, terminal.cols, terminal.rows).catch(() => {})
  return true
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
  const { t, i18n } = useTranslation()
  const toggleTerminal = useAppStore((state) => state.toggleTerminal)
  const appliedThemeId = useAppliedThemeId()
  const fontSize = useAppStore(selectTerminalFontSize)

  const [maximized, setMaximized] = useState(false)
  const [height, setHeight] = useState(DEFAULT_TERMINAL_HEIGHT)
  const panelRef = useRef<HTMLDivElement>(null)
  const [shellLabel, setShellLabel] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const shellRunningRef = useRef(false)
  const { show: showContextMenu, ContextMenuComponent: TerminalContextMenu } = useContextMenu()

  // Start a shell for this workspace unless one is already running or starting.
  const startShell = useCallback(async (): Promise<void> => {
    const terminal = terminalRef.current
    const fit = fitRef.current
    if (!terminal || !fit || shellRunningRef.current) return
    shellRunningRef.current = true
    fit.fit()
    try {
      const result = await window.piDesktop.terminal.start(workspaceId, {
        cols: terminal.cols,
        rows: terminal.rows,
      })
      if (terminalRef.current !== terminal) return
      setShellLabel(result.shell.split(/[\\/]/).pop() ?? result.shell)
    } catch (err) {
      if (terminalRef.current !== terminal) return
      shellRunningRef.current = false
      terminal.writeln(`Failed to start terminal: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [workspaceId])

  useEffect(() => {
    if (!containerRef.current) return

    const terminal = new XTerm({
      cursorBlink: true,
      convertEol: true,
      fontFamily: "'JetBrains Mono Variable', 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      // Later changes are applied live by the font size effect below.
      fontSize: selectTerminalFontSize(useAppStore.getState()),
      theme: buildTerminalTheme(),
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.loadAddon(new WebLinksAddon())
    terminal.open(containerRef.current)
    const platform = window.piDesktop.system.platform
    terminal.attachCustomKeyEventHandler(
      (event) => !isNativeClipboardShortcut(event, platform, terminal.hasSelection())
    )

    terminalRef.current = terminal
    fitRef.current = fit

    const dataDisposable = terminal.onData((data) => {
      // With no shell (e.g. after `exit`), the next key starts a new one.
      // That key only restarts: it is not sent to the new shell.
      if (!shellRunningRef.current) {
        void startShell()
        return
      }
      void window.piDesktop.terminal.input(workspaceId, data).catch(() => {})
    })
    const outputCleanup = window.piDesktop.terminal.onData((event) => {
      if (event.workspaceId === workspaceId) terminal.write(event.data)
    })
    const exitCleanup = window.piDesktop.terminal.onExit((event) => {
      if (event.workspaceId !== workspaceId) return
      shellRunningRef.current = false
      terminal.writeln('')
      terminal.writeln(`[process exited with code ${event.exitCode}]`)
      terminal.writeln(i18n.t('terminal.restartHint'))
    })

    const container = containerRef.current
    const observer = new ResizeObserver(() => fitAndResize(workspaceId, container, terminal, fit))
    observer.observe(container)

    return () => {
      observer.disconnect()
      dataDisposable.dispose()
      outputCleanup()
      exitCleanup()
      void window.piDesktop.terminal.stop(workspaceId).catch(() => {})
      shellRunningRef.current = false
      terminal.dispose()
      terminalRef.current = null
      fitRef.current = null
    }
  }, [workspaceId, startShell, i18n])

  // Start the shell when the panel is shown. A shell that exited (e.g. the
  // user typed `exit`) also starts fresh the next time the panel is shown.
  useEffect(() => {
    if (!visible || shellRunningRef.current) return
    const timer = window.setTimeout(() => void startShell(), 0)
    return () => window.clearTimeout(timer)
  }, [visible, startShell])

  useEffect(() => {
    if (!visible) return
    const timer = window.setTimeout(() => {
      const terminal = terminalRef.current
      const fit = fitRef.current
      if (terminal && fit && fitAndResize(workspaceId, containerRef.current, terminal, fit)) terminal.focus()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [visible, maximized, workspaceId])

  // Apply Terminal Font Size changes live, then refit so the pty size matches.
  useEffect(() => {
    const terminal = terminalRef.current
    const fit = fitRef.current
    if (!terminal || !fit || terminal.options.fontSize === fontSize) return
    terminal.options.fontSize = fontSize
    fitAndResize(workspaceId, containerRef.current, terminal, fit)
  }, [fontSize, workspaceId])

  // Recolor the live terminal when the app theme changes, without recreating it.
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = buildTerminalTheme()
    }
  }, [appliedThemeId])

  return (
    <div
      ref={panelRef}
      // Maximized takes the chat pane's full height, so the chat above it keeps
      // no height but stays mounted. Restore returns to the dragged height.
      style={{
        display: visible ? undefined : 'none',
        ...(maximized ? {} : { height, maxHeight: `${MAX_TERMINAL_HEIGHT_RATIO * 100}%` }),
      }}
      className={clsx(
        'flex min-h-0 shrink-0 flex-col border-t border-border bg-app',
        maximized && 'basis-full'
      )}
    >
      <ResizeHandle axis="y" onResize={(delta) => {
        const panel = panelRef.current
        if (!panel?.parentElement) return
        setHeight(clampTerminalHeight(panel.getBoundingClientRect().height - delta, panel.parentElement.clientHeight))
        setMaximized(false)
      }} />
      <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-1.5">
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
            title={t('terminal.hideTitle')}
            aria-label={t('terminal.hideTitle')}
          >
            <X size={12} />
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden p-2">
        <div
          ref={containerRef}
          className="min-h-0 min-w-0 flex-1"
          onContextMenu={(e) => {
            const terminal = terminalRef.current
            if (terminal) {
              showContextMenu(
                e,
                buildTerminalContextMenu(terminal, usesCtrlClipboardShortcuts(window.piDesktop.system.platform))
              )
            }
          }}
        />
      </div>
      {TerminalContextMenu}
    </div>
  )
}
