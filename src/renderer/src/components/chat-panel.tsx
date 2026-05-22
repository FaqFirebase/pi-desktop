import { useAppStore } from '../store'
import { ChatInput } from './chat-input'
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

type SidePanel = 'files' | 'diff' | null

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

  const [sidePanel, setSidePanel] = useState<SidePanel>(null)

  const scrollRef = useAutoScroll([messages.length, streamingContent])

  const handleRetry = useCallback(async (messageId: string) => {
    // Find the user message and resend it
    const msg = messages.find((m) => m.id === messageId)
    if (msg?.role === 'user') {
      await useAppStore.getState().sendPrompt(msg.content)
    }
  }, [messages])

  const activeWorkspace = useAppStore((state) => state.activeWorkspace)
  const showSidePanel = sidePanel !== null || selectedFile !== null

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
            <ChatInput />
          </div>
        </div>

        {/* Side panel */}
        {showSidePanel && (
          <div className="w-72 border-l border-neutral-800 flex flex-col overflow-hidden bg-neutral-950">
            {sidePanel === 'files' && <FileTree />}
            {sidePanel === 'diff' && <DiffViewer onClose={() => setSidePanel(null)} />}
            {!sidePanel && selectedFile && <FilePreview />}
            <button
              onClick={() => {
                setSidePanel(null)
                useAppStore.getState().setSelectedFile(null, null)
              }}
              className="absolute top-1 right-1 rounded p-1 text-neutral-600 hover:text-neutral-400 z-10"
            >
              <X size={12} />
            </button>
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
          PI Desktop
        </h2>
        <p className="mb-6 max-w-md text-sm text-neutral-500">
          {piStatus === 'running'
            ? 'Start a conversation with your coding agent. Ask it to build, debug, or explore your codebase.'
            : piStatus === 'starting'
              ? 'Starting PI agent...'
              : piStatus === 'error'
                ? 'Failed to start PI agent. Check settings.'
                : 'PI agent is not running. Start it from the sidebar or status bar.'}
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
