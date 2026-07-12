import { useAppStore } from '../store'
import { ChatInput } from './chat-input'
import { CouncilPanels } from './council-panels'
import { MessageBubble, ToolGroupBubble } from './message-bubble'
import { StreamingBubble } from './streaming-bubble'
import { ChatSearch } from './chat-search'
import { groupToolMessages, prepareChatMessages } from '../message-grouping'
import { FileTree, FileSearch, FilePreview } from './file-tree'
import { ImageViewer } from './image-viewer'
import { DiffViewer } from './diff-viewer'
import { TerminalPanel } from './terminal'
import { useChatScroll } from '../hooks'
import { useState, useCallback, useEffect, useMemo } from 'react'
import { clsx } from 'clsx'
import piLogo from '../assets/pi-logo.svg'
import {
  FolderTree,
  GitCompare,
  Terminal,
  ShieldCheck,
  PanelLeft,
  PanelLeftClose,
  X,
  ChevronDown,
} from 'lucide-react'

export function ChatPanel(): React.JSX.Element {
  const messages = useAppStore((state) => state.messages)
  const isStreaming = useAppStore((state) => state.isStreaming)
  const streamingContent = useAppStore((state) => state.streamingContent)
  const streamingThinking = useAppStore((state) => state.streamingThinking)
  const streamingToolCalls = useAppStore((state) => state.streamingToolCalls)
  const piStatus = useAppStore((state) => state.piStatus)
  const terminalOpen = useAppStore((state) => state.terminalOpen)
  const reviewOpen = useAppStore((state) => state.reviewOpen)
  const sidebarOpen = useAppStore((state) => state.sidebarOpen)
  const fileSearchOpen = useAppStore((state) => state.fileSearchOpen)
  const toggleFileSearch = useAppStore((state) => state.toggleFileSearch)
  const previewTarget = useAppStore((state) => state.previewTarget)

  // sidePanel lives in the store so it survives view switches (e.g. Settings
  // round-trip). Widths stay local — resetting them on remount is benign.
  const sidePanel = useAppStore((state) => state.chatSidePanel)
  const setSidePanel = useAppStore((state) => state.setChatSidePanel)
  const [sidePanelWidth, setSidePanelWidth] = useState(640)
  const [filePaneWidth, setFilePaneWidth] = useState(280)

  const currentView = useAppStore((state) => state.currentView)
  const { scrollRef, onScroll, atBottom, scrollToBottom } = useChatScroll(currentView === 'chat')

  // In-conversation search (Ctrl/Cmd+F while in chat). The nonce bumps on every
  // press so re-triggering refocuses/selects the already-open input.
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchNonce, setSearchNonce] = useState(0)
  useEffect(() => {
    if (currentView !== 'chat') return
    const onKey = (e: KeyboardEvent) => {
      // The 'F' (uppercase) case also covers Caps Lock. Ctrl/Cmd+F opens the
      // in-conversation find bar; adding Shift opens the workspace file-search
      // modal. Both handled here at the window level so they fire regardless of
      // focus (the file-search shortcut used to be composer-scoped, so it only
      // worked while the textarea had focus).
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault()
        if (e.shiftKey) {
          useAppStore.getState().toggleFileSearch()
        } else {
          setSearchOpen(true)
          setSearchNonce((n) => n + 1)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [currentView])

  // Fold consecutive tool-call/result runs into collapsed groups. Memoized so
  // the grouping only recomputes when the message list changes, and so lone
  // MessageBubbles keep their stable refs (no markdown re-parse on re-render).
  const renderItems = useMemo(() => groupToolMessages(prepareChatMessages(messages)), [messages])

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
  const showSidePanel = sidePanel !== null || previewTarget !== null
  const showFileTree = sidePanel === 'files'
  const showImage = previewTarget?.kind === 'image' && sidePanel !== 'diff'
  const showEditor = previewTarget?.kind === 'code' && sidePanel !== 'diff'
  const showDiff = sidePanel === 'diff'
  const showFileTreeOnly = showFileTree && !showEditor && !showImage
  const minSidePanelWidth = showFileTree && (showEditor || showImage) ? 600 : 360
  const effectiveSidePanelWidth = clamp(sidePanelWidth, minSidePanelWidth, 1280)
  const maxFilePaneWidth = Math.max(220, effectiveSidePanelWidth - 360)
  const effectiveFilePaneWidth = clamp(filePaneWidth, 220, maxFilePaneWidth)
  const sidePanelContentWidth = showFileTreeOnly ? effectiveFilePaneWidth : effectiveSidePanelWidth

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex flex-1 overflow-hidden">
        {/* Main chat area */}
        <div className="chat-center flex flex-1 flex-col overflow-hidden">
          {/* Toolbar */}
          <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-1.5">
            <div className="flex items-center gap-0.5">
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
                icon={sidebarOpen ? <PanelLeftClose size={14} /> : <PanelLeft size={14} />}
                active={false}
                onClick={() => useAppStore.getState().toggleSidebar()}
                title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
              />
              <ToolbarButton
                icon={<ShieldCheck size={14} />}
                active={reviewOpen}
                onClick={() => useAppStore.getState().toggleReview()}
                title="Review panel"
              />
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
          <div className="relative flex min-h-0 flex-1 flex-col">
            {searchOpen && (
              <ChatSearch
                containerRef={scrollRef}
                focusNonce={searchNonce}
                onClose={() => setSearchOpen(false)}
              />
            )}
            <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto">
              {messages.length === 0 && !isStreaming ? (
                <EmptyState piStatus={piStatus} />
              ) : (
                <div className="mx-auto max-w-5xl px-4 py-6">
                  {renderItems.map((item) =>
                    item.kind === 'toolGroup' ? (
                      <ToolGroupBubble
                        key={item.id}
                        title={item.title}
                        messages={item.messages}
                        onRetry={handleRetry}
                      />
                    ) : (
                      <MessageBubble key={item.message.id} message={item.message} onRetry={handleRetry} />
                    )
                  )}
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

            {/* Jump to bottom — shown while scrolled up, so streaming can keep
                its position until the user opts back into following. */}
            {!atBottom && (
              <button
                onClick={scrollToBottom}
                className="absolute bottom-3 left-1/2 flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-full border border-neutral-700 bg-neutral-800/90 text-neutral-300 shadow-lg shadow-black/30 backdrop-blur transition-colors hover:bg-neutral-700 hover:text-neutral-100"
                title="Scroll to bottom"
                aria-label="Scroll to bottom"
              >
                <ChevronDown size={16} />
              </button>
            )}
          </div>

          {/* Input area */}
          <div className="border-t border-neutral-800 bg-neutral-950">
            <div className="mx-auto w-full max-w-5xl px-4">
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
                  {(showEditor || showImage) && (
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
                <div
                  className={clsx(
                    'flex min-w-[360px] flex-1 flex-col overflow-hidden',
                    // Divider only when the file tree is beside it; alone, the
                    // outer panel's border-l is the left edge (avoids doubling).
                    showFileTree && 'border-l border-neutral-800'
                  )}
                >
                  <FilePreview />
                </div>
              )}
              {showImage && (
                <div className="flex min-w-[360px] flex-1 flex-col overflow-hidden">
                  <ImageViewer />
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
      <div className="w-px bg-transparent transition-colors group-hover:bg-blue-400" />
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
        'rounded p-1 transition-colors',
        active
          ? 'bg-neutral-800 text-neutral-200'
          : 'pi-hover-highlight text-neutral-500 hover:text-neutral-300'
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
        <img src={piLogo} alt="Pi Desktop" className="mx-auto mb-4 block h-16 w-16" />
        <h2 className="mb-6 text-2xl font-semibold text-neutral-100">
          Pi Desktop
        </h2>
        <p className="mb-6 max-w-3xl text-balance text-sm text-neutral-500">
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
