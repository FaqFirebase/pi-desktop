import { useEffect, useRef, useState } from 'react'
import { Terminal as XTerm, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { useAppStore } from '../store'
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

  const bg = v('--color-bg-primary', '#0a0a0a')
  const fg = v('--color-text-primary', '#d4d4d4')

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
    brightBlack: v('--color-text-muted', '#525252'),
    brightRed: v('--color-error', '#f87171'),
    brightGreen: v('--color-success', '#4ade80'),
    brightYellow: v('--color-warning', '#facc15'),
    brightBlue: v('--color-accent', '#60a5fa'),
    brightMagenta: v('--cm-keyword', '#c084fc'),
    brightCyan: v('--cm-link', '#22d3ee'),
    brightWhite: v('--color-text-secondary', '#ffffff'),
  }
}

export function TerminalPanel(): React.JSX.Element | null {
  const terminalOpen = useAppStore((state) => state.terminalOpen)
  const toggleTerminal = useAppStore((state) => state.toggleTerminal)
  const activeWorkspace = useAppStore((state) => state.activeWorkspace)
  const theme = useAppStore((state) => state.settings?.theme)

  const [maximized, setMaximized] = useState(false)
  const [shellLabel, setShellLabel] = useState<string>('Terminal')
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    if (!terminalOpen || !containerRef.current) return

    const terminal = new XTerm({
      cursorBlink: true,
      convertEol: true,
      fontFamily: "'JetBrains Mono Variable', 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      // Use the Terminal Font Size setting (or the unsaved settings draft),
      // read once at creation. Applied on the next mount — i.e. when the user
      // returns to chat — rather than live, to avoid resizing a hidden pty.
      // Falls back to the default.
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
      fit.fit()
      window.piDesktop.terminal.resize(terminal.cols, terminal.rows)
    }

    const dataDisposable = terminal.onData((data) => {
      window.piDesktop.terminal.input(data)
    })
    const outputCleanup = window.piDesktop.terminal.onData((data) => {
      terminal.write(data)
    })
    const exitCleanup = window.piDesktop.terminal.onExit((event) => {
      terminal.writeln('')
      terminal.writeln(`[process exited with code ${event.exitCode}]`)
    })

    window.setTimeout(async () => {
      fitAndResize()
      try {
        const result = await window.piDesktop.terminal.start({
          cwd: activeWorkspace?.path,
          cols: terminal.cols,
          rows: terminal.rows,
        })
        setShellLabel(result.shell.split('/').pop() ?? result.shell)
      } catch (err) {
        terminal.writeln(`Failed to start terminal: ${err instanceof Error ? err.message : String(err)}`)
      }
      terminal.focus()
    }, 0)

    window.addEventListener('resize', fitAndResize)

    return () => {
      window.removeEventListener('resize', fitAndResize)
      dataDisposable.dispose()
      outputCleanup()
      exitCleanup()
      window.piDesktop.terminal.stop()
      terminal.dispose()
      terminalRef.current = null
      fitRef.current = null
    }
  }, [terminalOpen, activeWorkspace?.path])

  useEffect(() => {
    if (!terminalOpen) return
    window.setTimeout(() => {
      fitRef.current?.fit()
      const terminal = terminalRef.current
      if (terminal) {
        window.piDesktop.terminal.resize(terminal.cols, terminal.rows)
      }
    }, 0)
  }, [terminalOpen, maximized])

  // Recolor the live terminal when the app theme changes, without recreating it.
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = buildTerminalTheme()
    }
  }, [theme])

  if (!terminalOpen) return null

  return (
    <div
      className={clsx(
        'flex flex-col border-t border-neutral-800 bg-neutral-950',
        maximized ? 'flex-1' : 'h-64'
      )}
    >
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-1.5">
        <div className="flex items-center gap-2">
          <TerminalIcon size={14} className="text-neutral-500" />
          <span className="text-xs text-neutral-400">Terminal</span>
          <span className="text-[10px] text-neutral-600">{shellLabel}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => terminalRef.current?.clear()}
            className="rounded p-1 text-neutral-600 hover:text-neutral-400 transition-colors"
            title="Clear"
            aria-label="Clear terminal"
          >
            <Trash2 size={12} />
          </button>
          <button
            onClick={() => setMaximized(!maximized)}
            className="rounded p-1 text-neutral-600 hover:text-neutral-400 transition-colors"
            title={maximized ? 'Restore terminal' : 'Maximize terminal'}
            aria-label={maximized ? 'Restore terminal' : 'Maximize terminal'}
          >
            {maximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          </button>
          <button
            onClick={toggleTerminal}
            className="rounded p-1 text-neutral-600 hover:text-neutral-400 transition-colors"
            title="Close terminal"
            aria-label="Close terminal"
          >
            <X size={12} />
          </button>
        </div>
      </div>

      <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden p-2" />
    </div>
  )
}
