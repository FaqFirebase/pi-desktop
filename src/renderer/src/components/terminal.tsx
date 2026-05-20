import { useEffect, useRef, useState, useCallback } from 'react'
import { useAppStore } from '../store'
import { clsx } from 'clsx'
import {
  Terminal as TerminalIcon,
  X,
  Maximize2,
  Minimize2,
  Trash2,
  Square,
  Loader2,
} from 'lucide-react'

// Terminal output entry
interface TerminalEntry {
  id: string
  type: 'stdout' | 'stderr' | 'input' | 'system'
  content: string
  timestamp: number
}

export function TerminalPanel(): React.JSX.Element | null {
  const terminalOpen = useAppStore((state) => state.terminalOpen)
  const toggleTerminal = useAppStore((state) => state.toggleTerminal)
  const piStatus = useAppStore((state) => state.piStatus)

  const [entries, setEntries] = useState<TerminalEntry[]>([])
  const [inputValue, setInputValue] = useState('')
  const [isExecuting, setIsExecuting] = useState(false)
  const [maximized, setMaximized] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [entries])

  // Subscribe to PI stderr
  useEffect(() => {
    const unsubscribe = window.piDesktop.onEvent((event) => {
      if (event.type === 'tool_execution_update') {
        const toolEvent = event as { toolName?: string; partialResult?: { content?: Array<{ type?: string; text?: string }> } }
        if (toolEvent.toolName === 'bash' && toolEvent.partialResult?.content) {
          const text = toolEvent.partialResult.content
            .filter((c) => c.type === 'text')
            .map((c) => c.text ?? '')
            .join('')
          if (text) {
            setEntries((prev) => [...prev, {
              id: `out-${Date.now()}`,
              type: 'stdout',
              content: text,
              timestamp: Date.now(),
            }])
          }
        }
      }
    })

    return unsubscribe
  }, [])

  const handleExecute = useCallback(async () => {
    if (!inputValue.trim() || piStatus !== 'running') return

    const command = inputValue.trim()
    setInputValue('')
    setIsExecuting(true)

    // Add input entry
    setEntries((prev) => [...prev, {
      id: `in-${Date.now()}`,
      type: 'input',
      content: command,
      timestamp: Date.now(),
    }])

    try {
      const result = await window.piDesktop.commands.bash(command) as {
        success?: boolean
        data?: {
          output?: string
          exitCode?: number
          cancelled?: boolean
          truncated?: boolean
        }
        error?: string
      }

      if (result?.success && result.data) {
        if (result.data.output) {
          setEntries((prev) => [...prev, {
            id: `out-${Date.now()}`,
            type: 'stdout',
            content: result.data!.output!,
            timestamp: Date.now(),
          }])
        }
        if (result.data.exitCode !== 0) {
          setEntries((prev) => [...prev, {
            id: `exit-${Date.now()}`,
            type: 'system',
            content: `Exit code: ${result.data!.exitCode}`,
            timestamp: Date.now(),
          }])
        }
      } else if (result?.error) {
        setEntries((prev) => [...prev, {
          id: `err-${Date.now()}`,
          type: 'stderr',
          content: result.error!,
          timestamp: Date.now(),
        }])
      }
    } catch (err) {
      setEntries((prev) => [...prev, {
        id: `err-${Date.now()}`,
        type: 'stderr',
        content: err instanceof Error ? err.message : String(err),
        timestamp: Date.now(),
      }])
    } finally {
      setIsExecuting(false)
    }
  }, [inputValue, piStatus])

  if (!terminalOpen) return null

  return (
    <div
      className={clsx(
        'flex flex-col border-t border-neutral-800 bg-neutral-950',
        maximized ? 'flex-1' : 'h-64'
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-1.5">
        <div className="flex items-center gap-2">
          <TerminalIcon size={14} className="text-neutral-500" />
          <span className="text-xs text-neutral-400">Terminal</span>
          {isExecuting && (
            <Loader2 size={12} className="animate-spin text-blue-400" />
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setEntries([])}
            className="rounded p-1 text-neutral-600 hover:text-neutral-400 transition-colors"
            title="Clear"
          >
            <Trash2 size={12} />
          </button>
          <button
            onClick={() => setMaximized(!maximized)}
            className="rounded p-1 text-neutral-600 hover:text-neutral-400 transition-colors"
          >
            {maximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          </button>
          <button
            onClick={toggleTerminal}
            className="rounded p-1 text-neutral-600 hover:text-neutral-400 transition-colors"
          >
            <X size={12} />
          </button>
        </div>
      </div>

      {/* Output */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-3 py-2 font-mono text-xs"
      >
        {entries.length === 0 ? (
          <div className="text-neutral-600 py-4 text-center">
            Run bash commands from the chat or type below
          </div>
        ) : (
          entries.map((entry) => (
            <TerminalLine key={entry.id} entry={entry} />
          ))
        )}
      </div>

      {/* Input */}
      <div className="border-t border-neutral-800 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-emerald-400 font-mono">$</span>
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleExecute()
              }
            }}
            placeholder={piStatus !== 'running' ? 'PI not running...' : 'Type a command...'}
            disabled={piStatus !== 'running' || isExecuting}
            className="flex-1 bg-transparent text-xs text-neutral-200 placeholder:text-neutral-600 outline-none font-mono disabled:opacity-50"
          />
          {isExecuting && (
            <button
              onClick={() => window.piDesktop.commands.abortBash()}
              className="rounded p-1 text-red-400 hover:bg-red-900/20 transition-colors"
              title="Stop"
            >
              <Square size={10} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function TerminalLine({ entry }: { entry: TerminalEntry }): React.JSX.Element {
  const colorClass = {
    stdout: 'text-neutral-300',
    stderr: 'text-red-400',
    input: 'text-emerald-400',
    system: 'text-blue-400',
  }[entry.type]

  return (
    <div className={clsx('whitespace-pre-wrap break-all leading-relaxed', colorClass)}>
      {entry.type === 'input' && <span className="text-emerald-500 mr-2">$</span>}
      <AnsiText text={entry.content} />
    </div>
  )
}

/**
 * Renders ANSI escape codes as styled spans.
 * Handles: colors (30-37, 90-97), bold (1), dim (2), italic (3), underline (4), reset (0)
 */
function AnsiText({ text }: { text: string }): React.JSX.Element {
  // Parse ANSI escape sequences
  const parts = parseAnsi(text)

  return (
    <>
      {parts.map((part, i) => (
        <span key={i} style={part.style}>
          {part.text}
        </span>
      ))}
    </>
  )
}

interface AnsiPart {
  text: string
  style: React.CSSProperties
}

function parseAnsi(text: string): AnsiPart[] {
  const parts: AnsiPart[] = []
  const regex = /\x1b\[([0-9;]*)m/g

  let lastIndex = 0
  let currentStyle: React.CSSProperties = {}

  let match
  while ((match = regex.exec(text)) !== null) {
    // Add text before this escape sequence
    if (match.index > lastIndex) {
      parts.push({
        text: text.slice(lastIndex, match.index),
        style: { ...currentStyle },
      })
    }

    // Parse the escape codes
    const codes = match[1].split(';').map(Number)
    for (const code of codes) {
      if (code === 0) {
        currentStyle = {}
      } else if (code === 1) {
        currentStyle.fontWeight = 'bold'
      } else if (code === 2) {
        currentStyle.opacity = '0.7'
      } else if (code === 3) {
        currentStyle.fontStyle = 'italic'
      } else if (code === 4) {
        currentStyle.textDecoration = 'underline'
      } else if (code === 7) {
        // Reverse - swap fg/bg (simplified)
        currentStyle.filter = 'invert(1)'
      } else if (code >= 30 && code <= 37) {
        currentStyle.color = ANSI_COLORS[code - 30]
      } else if (code >= 40 && code <= 47) {
        currentStyle.backgroundColor = ANSI_COLORS[code - 40]
      } else if (code >= 90 && code <= 97) {
        currentStyle.color = ANSI_BRIGHT_COLORS[code - 90]
      } else if (code >= 100 && code <= 107) {
        currentStyle.backgroundColor = ANSI_BRIGHT_COLORS[code - 100]
      }
    }

    lastIndex = match.index + match[0].length
  }

  // Add remaining text
  if (lastIndex < text.length) {
    parts.push({
      text: text.slice(lastIndex),
      style: { ...currentStyle },
    })
  }

  // If no parts, return the whole text as-is
  if (parts.length === 0) {
    parts.push({ text, style: {} })
  }

  return parts
}

const ANSI_COLORS: Record<number, string> = {
  0: '#000000', // black
  1: '#ef4444', // red
  2: '#22c55e', // green
  3: '#eab308', // yellow
  4: '#3b82f6', // blue
  5: '#a855f7', // magenta
  6: '#06b6d4', // cyan
  7: '#d4d4d8', // white
}

const ANSI_BRIGHT_COLORS: Record<number, string> = {
  0: '#525252', // bright black (gray)
  1: '#f87171', // bright red
  2: '#4ade80', // bright green
  3: '#facc15', // bright yellow
  4: '#60a5fa', // bright blue
  5: '#c084fc', // bright magenta
  6: '#22d3ee', // bright cyan
  7: '#ffffff', // bright white
}
