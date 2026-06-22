import { useAppStore } from '../store'
import { ChatInput } from './chat-input'
import { CouncilPanels } from './council-panels'
import { MessageBubble } from './message-bubble'
import { StreamingBubble } from './streaming-bubble'
import { FileTree, FileSearch, FilePreview } from './file-tree'
import { DiffViewer } from './diff-viewer'
import { TerminalPanel } from './terminal'
import { useAutoScroll } from '../hooks'
import { useState, useCallback } from 'react'
import { clsx } from 'clsx'
import {
  FolderTree,
  GitCompare,
  Terminal,
  X,
} from 'lucide-react'

export function ChatPanel(): React.JSX.Element {
  const messages = useAppStore((state) => state.messages)
  const isStreaming = useAppStore((state) => state.isStreaming)
  const streamingContent = useAppStore((state) => state.streamingContent)
  const streamingThinking = useAppStore((state) => state.streamingThinking)
  const streamingToolCalls = useAppStore((state) => state.streamingToolCalls)
  const piStatus = useAppStore((state) => state.piStatus)
  const terminalOpen = useAppStore((state) => state.terminalOpen)
  const fileSearchOpen = useAppStore((state) => state.fileSearchOpen)
  const toggleFileSearch = useAppStore((state) => state.toggleFileSearch)
  const selectedFile = useAppStore((state) => state.selectedFile)

  // sidePanel lives in the store so it survives view switches (e.g. Settings
  // round-trip). Widths stay local — resetting them on remount is benign.
  const sidePanel = useAppStore((state) => state.chatSidePanel)
  const setSidePanel = useAppStore((state) => state.setChatSidePanel)
  const [sidePanelWidth, setSidePanelWidth] = useState(640)
  const [filePaneWidth, setFilePaneWidth] = useState(280)

  const scrollRef = useAutoScroll([messages.length, streamingContent])

  const handleRetry = useCallback(async (messageId: string) => {
    // Read from the store so this callback stays referentially stable, keeping
    // the memoized MessageBubble list from re-rendering when messages change.
    const { messages: current, sendPrompt } = useAppStore.getState()
    const msg = current.find((m) => m.id === messageId)
    if (msg?.role === 'user') {
      await sendPrompt(msg.content)
    }
  }, [])

  const activeWorkspace = useAppStore((state) => state.activeWorkspace)
  const showSidePanel = sidePanel !== null || selectedFile !== null
  const showFileTree = sidePanel === 'files'
  const showEditor = selectedFile !== null && sidePanel !== 'diff'
  const showDiff = sidePanel === 'diff'
  const showFileTreeOnly = showFileTree && !showEditor
  const minSidePanelWidth = showFileTree && showEditor ? 600 : 360
  const effectiveSidePanelWidth = clamp(sidePanelWidth, minSidePanelWidth, 1280)
  const maxFilePaneWidth = Math.max(220, effectiveSidePanelWidth - 360)
  const effectiveFilePaneWidth = clamp(filePaneWidth, 220, maxFilePaneWidth)
  const sidePanelContentWidth = showFileTreeOnly ? effectiveFilePaneWidth : effectiveSidePanelWidth

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex flex-1 overflow-hidden">
        {/* Main chat area */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Toolbar */}
          <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-1.5">
            <div className="flex items-center gap-1">
              {/* Workspace path — always visible */}
              {activeWorkspace && (
                <div className="flex items-center gap-1.5 mr-2 px-2 py-0.5 rounded bg-neutral-800/60" title={activeWorkspace.path}>
                  <FolderTree size={12} className="text-neutral-500 shrink-0" />
                  <span className="text-xs text-neutral-400 max-w-[300px] truncate">
                    {activeWorkspace.name}: {activeWorkspace.path}
                  </span>
                </div>
              )}
              <ToolbarButton
                icon={<FolderTree size={14} />}
                active={sidePanel === 'files'}
                onClick={() => setSidePanel(sidePanel === 'files' ? null : 'files')}
                title="File tree"
              />
              <ToolbarButton
                icon={<GitCompare size={14} />}
                active={sidePanel === 'diff'}
                onClick={() => setSidePanel(sidePanel === 'diff' ? null : 'diff')}
                title="Diff viewer"
              />
              <ToolbarButton
                icon={<Terminal size={14} />}
                active={terminalOpen}
                onClick={() => useAppStore.getState().toggleTerminal()}
                title="Terminal"
              />
            </div>
          </div>

          {/* Messages area */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto">
            {messages.length === 0 && !isStreaming ? (
              <EmptyState piStatus={piStatus} />
            ) : (
              <div className="mx-auto max-w-3xl px-4 py-6">
                {messages.map((message) => (
                  <MessageBubble key={message.id} message={message} onRetry={handleRetry} />
                ))}
                {isStreaming && (
                  <StreamingBubble
                    content={streamingContent}
                    thinking={streamingThinking}
                    toolCalls={streamingToolCalls}
                  />
                )}
              </div>
            )}
          </div>

          {/* Input area */}
          <div className="border-t border-neutral-800 bg-neutral-950">
            <div className="mx-auto w-full max-w-3xl px-4">
              <CouncilPanels />
            </div>
            <ChatInput />
          </div>
        </div>

        {/* Side panel */}
        {showSidePanel && (
          <div className="relative flex border-l border-neutral-800 bg-neutral-950" style={{ width: sidePanelContentWidth }}>
            <ResizeHandle
              onResize={(delta) => {
                if (showFileTreeOnly) {
                  setFilePaneWidth((width) => clamp(width - delta, 220, 520))
                  return
                }

                setSidePanelWidth((width) => clamp(width - delta, minSidePanelWidth, 1280))
              }}
            />
            <div className="flex min-w-0 flex-1 overflow-hidden">
              {showFileTree && (
                <>
                  <div className="flex min-w-0 shrink-0 flex-col overflow-hidden" style={{ width: effectiveFilePaneWidth }}>
                    <FileTree />
                  </div>
                  {showEditor && (
                    <ResizeHandle
                      onResize={(delta) => setFilePaneWidth((width) => clamp(width + delta, 220, maxFilePaneWidth))}
                    />
                  )}
                </>
              )}
              {showDiff && (
                <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                  <DiffViewer onClose={() => setSidePanel(null)} />
                </div>
              )}
              {showEditor && (
                <div className="flex min-w-[360px] flex-1 flex-col overflow-hidden border-l border-neutral-800">
                  <FilePreview />
                </div>
              )}
            </div>
            {showFileTreeOnly && (
              <button
                onClick={() => setSidePanel(null)}
                className="absolute top-1 right-1 z-10 rounded p-1 text-neutral-600 hover:text-neutral-400"
                title="Close file tree"
              >
                <X size={12} />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Terminal panel */}
      <TerminalPanel />

      {/* File search modal */}
      <FileSearch isOpen={fileSearchOpen} onClose={toggleFileSearch} />
    </div>
  )
}

function ResizeHandle({ onResize }: { onResize: (delta: number) => void }): React.JSX.Element {
  const handleMouseDown = (event: React.MouseEvent) => {
    event.preventDefault()
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    let lastX = event.clientX

    const handleMouseMove = (moveEvent: MouseEvent) => {
      onResize(moveEvent.clientX - lastX)
      lastX = moveEvent.clientX
    }

    const handleMouseUp = () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }

  return (
    <div
      onMouseDown={handleMouseDown}
      className="group flex w-2 shrink-0 cursor-col-resize items-stretch justify-center bg-neutral-950 transition-colors hover:bg-neutral-800"
      title="Drag to resize"
    >
      <div className="w-px bg-neutral-700 transition-colors group-hover:bg-blue-400" />
    </div>
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function ToolbarButton({
  icon,
  active,
  onClick,
  title,
}: {
  icon: React.ReactNode
  active: boolean
  onClick: () => void
  title: string
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'rounded p-1.5 transition-colors',
        active
          ? 'bg-neutral-800 text-neutral-200'
          : 'text-neutral-500 hover:bg-neutral-800/50 hover:text-neutral-300'
      )}
      title={title}
    >
      {icon}
    </button>
  )
}

function EmptyState({ piStatus }: { piStatus: string }): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center px-4">
      <div className="text-center">
        <div className="mb-4 text-4xl">⌘</div>
        <h2 className="mb-2 text-lg font-medium text-neutral-200">
          Pi Desktop
        </h2>
        <p className="mb-6 max-w-md text-sm text-neutral-500">
          {piStatus === 'running'
            ? 'Start a conversation with your coding agent. Ask it to build, debug, or explore your codebase.'
            : piStatus === 'starting'
              ? 'Starting Pi agent...'
              : piStatus === 'error'
                ? 'Failed to start Pi agent. Check settings.'
                : 'Pi agent is not running. Start it from the sidebar or status bar.'}
        </p>
        {piStatus === 'running' && (
          <div className="flex flex-wrap justify-center gap-2">
            {EXAMPLE_PROMPTS.map((prompt) => (
              <button
                key={prompt}
                onClick={() => {
                  useAppStore.getState().sendPrompt(prompt)
                }}
                className="rounded-lg border border-neutral-700 px-3 py-1.5 text-xs text-neutral-400 hover:border-neutral-600 hover:text-neutral-300 transition-colors"
              >
                {prompt}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

const EXAMPLE_PROMPTS = [
  'Explain this project structure',
  'Find all TODO comments',
  'Run the test suite',
  'Help me debug an error',
]
