import { sidePanelHidesPreview, useAppStore } from '../store'
import { agentEngineLabel } from '../../../shared/agent-engine-label'
import { PI_DESKTOP_PRODUCT_NAME } from '../../../shared/product-name'
import { ChatInput } from './chat-input'
import { ChatProjectPicker } from './chat-project-picker'
import { CouncilPanels } from './council-panels'
import { MessageBubble, ToolGroupBubble } from './message-bubble'
import { StreamingBubble } from './streaming-bubble'
import { ChatSearch } from './chat-search'
import { ResizeHandle } from './resize-handle'
import {
  DEFAULT_FILE_PANE_WIDTH,
  DEFAULT_SIDE_PANEL_WIDTH,
  MIN_CHAT_COLUMN_WIDTH,
  MIN_EDITOR_PANE_WIDTH,
  MIN_FILE_PANE_WIDTH,
  clamp,
  resolvePaneLayout,
  resolveSidePanelMetrics,
  sidePanelContentMinWidth,
} from './chat-panel-widths'
import { ReviewRail } from './review-rail'

import { groupToolMessages, prepareChatMessages } from '../message-grouping'
import { NowContext } from '../utils/relative-time'
import { FileTree, FileSearch, FilePreview } from './file-tree'
import { ImageViewer } from './image-viewer'
import { DiffViewer } from './diff-viewer'
import { SubagentPanel } from './subagent-panel'
import { TerminalPanel } from './terminal'
import { isFileWatchDemanded, useChatScroll, useChatVisible, useChatWidth } from '../hooks'
import { messageColumnClass } from '../utils/chat-width'
import { createMeasureRef } from '../utils/element-measure'
import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { clsx } from 'clsx'
import piLogo from '../assets/pi-logo.svg'
import { X, ChevronDown, Loader2 } from 'lucide-react'

// Fallback padding when the composer has not measured yet (~idle pill + gradient).
const DEFAULT_COMPOSER_PAD_PX = 144

const readComposerPad = (element: HTMLElement): number => Math.max(element.offsetHeight, DEFAULT_COMPOSER_PAD_PX)
const readClientWidth = (element: HTMLElement): number => element.clientWidth

/** `read(element)` for the element given the returned ref, updated whenever it mounts or resizes. */
function useElementMeasure(read: (element: HTMLElement) => number, fallback: number): [number, (element: HTMLElement | null) => void] {
  const [value, setValue] = useState(fallback)
  const ref = useMemo(() => createMeasureRef(read, setValue), [read])
  return [value, ref]
}

export function ChatPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const messages = useAppStore((state) => state.messages)
  const sessionLoading = useAppStore((state) => state.sessionLoading)
  const isStreaming = useAppStore((state) => state.isStreaming)
  const reattachedMidTurn = useAppStore((state) => state.reattachedMidTurn)
  // Drive message-list bottom padding from the real floating composer height so
  // a tall draft / attachments row never permanently covers the last message.
  // The composer mounts only once the empty chat has messages, hence the ref.
  const [composerPadPx, composerWrapRef] = useElementMeasure(readComposerPad, DEFAULT_COMPOSER_PAD_PX)
  // The chat column and side panel share this row; the side panel gets what the column leaves.
  const [panelRowWidth, panelRowRef] = useElementMeasure(readClientWidth, Number.POSITIVE_INFINITY)
  const chatDropZoneRef = useRef<HTMLDivElement>(null)
  const streamingContent = useAppStore((state) => state.streamingContent)
  const streamingThinking = useAppStore((state) => state.streamingThinking)
  const streamingToolCalls = useAppStore((state) => state.streamingToolCalls)
  const piStatus = useAppStore((state) => state.piStatus)
  const piStartupPhase = useAppStore((state) => state.piStartupPhase)
  const engineLabel = useAppStore((state) => agentEngineLabel(state.piEngine) ?? 'Pi')
  const fileSearchOpen = useAppStore((state) => state.fileSearchOpen)
  const toggleFileSearch = useAppStore((state) => state.toggleFileSearch)
  const previewTarget = useAppStore((state) => state.previewTarget)
  const reviewOpen = useAppStore((state) => state.reviewOpen)
  const messageColumn = messageColumnClass(useChatWidth())

  // sidePanel lives in the store so it survives view switches (e.g. Settings
  // round-trip). Widths stay local — resetting them on remount is benign.
  const sidePanel = useAppStore((state) => state.chatSidePanel)
  const setSidePanel = useAppStore((state) => state.setChatSidePanel)
  const [sidePanelWidth, setSidePanelWidth] = useState(DEFAULT_SIDE_PANEL_WIDTH)
  const [filePaneWidth, setFilePaneWidth] = useState(DEFAULT_FILE_PANE_WIDTH)

  // One shared clock for all relative-time labels — refresh every 30s so
  // "5 minutes ago" stays current without each label owning a timer.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  // This panel stays mounted behind `display: none` when another view or the
  // global workflow panel takes over, so useChatVisible — not the view alone —
  // decides whether chat is on screen. Without it the scroll hook never sees
  // the hidden→shown edge and cannot re-anchor the reading position.
  const chatVisible = useChatVisible()
  const { scrollRef, onScroll, atBottom, scrollToBottom } = useChatScroll(chatVisible, composerPadPx)

  // In-conversation search (Ctrl/Cmd+F while in chat). The nonce bumps on every
  // press so re-triggering refocuses/selects the already-open input.
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchNonce, setSearchNonce] = useState(0)
  useEffect(() => {
    // Same visibility test as the scroll hook: a hidden panel must not capture
    // the shortcut and open its find bar off screen.
    if (!chatVisible) return
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
  }, [chatVisible])

  // Fold consecutive tool-call/result runs into collapsed groups. Memoized so
  // the grouping only recomputes when the message list changes, and so lone
  // MessageBubbles keep their stable refs (no markdown re-parse on re-render).
  const renderItems = useMemo(
    () => groupToolMessages(prepareChatMessages(messages), t, isStreaming),
    [messages, t, isStreaming]
  )

  const handleRetry = useCallback(async (messageId: string) => {
    // Read from the store so this callback stays referentially stable, keeping
    // the memoized MessageBubble list from re-rendering when messages change.
    const { messages: current, sendPrompt } = useAppStore.getState()
    const msg = current.find((m) => m.id === messageId)
    if (msg?.role === 'user') {
      await sendPrompt(msg.content)
    }
  }, [])

  const showSidePanel = sidePanel !== null || previewTarget !== null
  const showFileTree = sidePanel === 'files'
  // The diff and the Tasks panel take the whole side slot; previews wait behind them.
  const previewAllowed = !sidePanelHidesPreview(sidePanel)
  const showImage = previewTarget?.kind === 'image' && previewAllowed
  const showEditor = previewTarget?.kind === 'code' && previewAllowed
  const showDiff = sidePanel === 'diff'
  const showTasks = sidePanel === 'tasks'
  const sidePanes = { showFileTree, showEditor, showImage }
  const paneLayout = resolvePaneLayout(
    panelRowWidth,
    showSidePanel ? sidePanelContentMinWidth(sidePanes) : null,
    reviewOpen && chatVisible
  )
  const sidePanelStacked = paneLayout.sidePanel === 'stacked'
  const {
    fileTreeOnly: showFileTreeOnly,
    minSidePanelWidth,
    maxSidePanelWidth,
    contentWidth: sidePanelContentWidth,
    filePaneWidth: effectiveFilePaneWidth,
    maxFilePaneWidth,
  } = resolveSidePanelMetrics(
    sidePanes,
    sidePanelWidth,
    filePaneWidth,
    // Stacked under the chat column, the side panel spans that column, so its
    // ceiling is the whole column rather than what the column leaves beside it.
    sidePanelStacked ? paneLayout.sidePanelRowWidth + MIN_CHAT_COLUMN_WIDTH : paneLayout.sidePanelRowWidth
  )
  const paneBesideChat = paneLayout.sidePanel === 'beside' || paneLayout.review === 'beside'
  const paneUnderChat = sidePanelStacked || paneLayout.review === 'stacked'

  // Disk watching is demand-driven: the main process only attaches chokidar
  // while a visible files or diff panel consumes change events. Without this,
  // cold start and the Home view would pay the full workspace-watch cost for a
  // tree nobody is looking at — and ChatPanel stays mounted (just hidden)
  // when navigating away, so visibility has to be part of the demand. It
  // lives here, in the one panel that is always mounted, so the Diff view's
  // demand and the chat panes' demand never race each other. The tree and the
  // diff still load on open, and both reload once when they become visible
  // again, with the tree's safety poll + focus refresh covering the rest.
  const fileWatchDemanded = useAppStore(isFileWatchDemanded)
  useEffect(() => {
    void window.piDesktop.files.setWatchDemand(fileWatchDemanded).catch(() => {})
    return () => {
      void window.piDesktop.files.setWatchDemand(false).catch(() => {})
    }
  }, [fileWatchDemanded])

  const sidePanelPane = showSidePanel ? (
    <div
      className={clsx(
        'relative flex bg-app',
        sidePanelStacked ? 'min-h-0 flex-1 border-t border-border' : 'shrink-0 border-l border-border'
      )}
      style={sidePanelStacked ? undefined : { width: sidePanelContentWidth }}
    >
      {!sidePanelStacked && (
        <ResizeHandle
          onResize={(delta) => {
            if (showFileTreeOnly) {
              // Same ceiling the render uses, so the state cannot outrun it.
              setFilePaneWidth((width) =>
                clamp(width - delta, MIN_FILE_PANE_WIDTH, maxFilePaneWidth)
              )
              return
            }

            setSidePanelWidth((width) =>
              clamp(width - delta, minSidePanelWidth, maxSidePanelWidth)
            )
          }}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-row-reverse overflow-hidden">
        {showFileTree && (
          <>
            {/* Stacked alone, the tree spans the column; beside the chat it keeps its dragged width. */}
            <div
              className={clsx('flex min-w-0 flex-col overflow-hidden', showFileTreeOnly && sidePanelStacked ? 'flex-1' : 'shrink-0')}
              style={showFileTreeOnly && sidePanelStacked ? undefined : { width: effectiveFilePaneWidth }}
            >
              <FileTree />
            </div>
            {(showEditor || showImage) && (
              <ResizeHandle
                onResize={(delta) =>
                  setFilePaneWidth((width) =>
                    clamp(width - delta, MIN_FILE_PANE_WIDTH, maxFilePaneWidth)
                  )
                }
              />
            )}
          </>
        )}
        {showDiff && (
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <DiffViewer onClose={() => setSidePanel(null)} />
          </div>
        )}
        {showTasks && (
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <SubagentPanel onClose={() => setSidePanel(null)} />
          </div>
        )}
        {showEditor && (
          <div
            className={clsx(
              'flex flex-1 flex-col overflow-hidden',
              // Separate the preview from the file tree on its right.
              showFileTree && 'border-r border-border'
            )}
            // The same constant the file pane's ceiling reserves for.
            style={{ minWidth: MIN_EDITOR_PANE_WIDTH }}
          >
            <FilePreview />
          </div>
        )}
        {showImage && (
          <div
            className="flex flex-1 flex-col overflow-hidden"
            style={{ minWidth: MIN_EDITOR_PANE_WIDTH }}
          >
            <ImageViewer />
          </div>
        )}
      </div>
      {showFileTreeOnly && (
        <button
          onClick={() => setSidePanel(null)}
          className="absolute top-1 right-1 z-10 flex h-6 w-6 items-center justify-center rounded text-faint hover:text-muted"
          title={t('chat.closeFileTree')}
        >
          <X size={12} />
        </button>
      )}
    </div>
  ) : null

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div ref={panelRowRef} className="flex min-h-0 flex-1 overflow-hidden">
        {/* Panes beside the column leave it this width; without room they stack under it. */}
        <div className="chat-center flex flex-1 flex-col overflow-hidden" style={paneBesideChat ? { minWidth: MIN_CHAT_COLUMN_WIDTH } : undefined}>
          <div ref={chatDropZoneRef} className="relative flex min-h-0 flex-1 flex-col">
            {searchOpen && (
              <ChatSearch
                containerRef={scrollRef}
                focusNonce={searchNonce}
                onClose={() => setSearchOpen(false)}
              />
            )}
            {(() => {
              const isEmptyChat =
                !sessionLoading && messages.length === 0 && !isStreaming

              // Empty session: Codex-style center prompt + project picker (sidebar chrome).
              if (isEmptyChat) {
                return (
                  <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-10">
                    <div className="mb-8 text-center">
                      <img
                        src={piLogo}
                        alt={PI_DESKTOP_PRODUCT_NAME}
                        className="mx-auto mb-4 block h-14 w-14"
                      />
                      <h2 className="text-2xl font-semibold text-primary">
                        {t('chat.emptyState.title', { agent: engineLabel })}
                      </h2>
                      <p className="mt-1 text-sm text-dim">
                        {piStatus === 'running'
                          ? t('chat.emptyState.pickProject')
                          : piStatus === 'starting'
                            ? piStartupPhase === 'waiting-on-engine'
                              ? t('chat.emptyState.waitingOnEngine', { agent: engineLabel })
                              : t('chat.emptyState.starting', { agent: engineLabel })
                            : piStatus === 'error'
                              ? t('chat.emptyState.startFailed', { agent: engineLabel })
                              : t('chat.emptyState.chooseProject', { agent: engineLabel })}
                      </p>
                    </div>
                    <div className={clsx('w-full', messageColumn)}>
                      {piStatus === 'running' && (
                        <div className="mb-4 flex flex-wrap justify-center gap-2 px-4">
                          {EXAMPLE_PROMPTS.map((prompt) => (
                            <button
                              key={prompt}
                              type="button"
                              onClick={() => {
                                // Fill the composer only — never start a turn from a chip misclick.
                                useAppStore.getState().insertPrompt(prompt, true)
                              }}
                              className="rounded-lg border border-border-strong px-3 py-1.5 text-xs text-muted hover:border-border-strong-hover hover:text-secondary transition-colors"
                            >
                              {prompt}
                            </button>
                          ))}
                        </div>
                      )}
                      <ChatInput dropZoneRef={chatDropZoneRef} />
                      <div className="px-4">
                        <ChatProjectPicker />
                      </div>
                    </div>
                  </div>
                )
              }

              return (
                <>
                  <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto">
                    {sessionLoading && messages.length === 0 && !isStreaming ? (
                      <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-dim">
                        <div className="h-5 w-5 animate-spin rounded-full border-2 border-border-strong border-t-accent" />
                        {piStatus === 'running' ? t('chat.loadingSession') : t('chat.startingAgent')}
                      </div>
                    ) : (
                      <NowContext.Provider value={now}>
                        <div
                          className={clsx('mx-auto px-4 pt-6', messageColumn)}
                          style={{ paddingBottom: composerPadPx }}
                        >
                          {renderItems.map((item) =>
                            item.kind === 'toolGroup' ? (
                              <ToolGroupBubble
                                key={item.id}
                                title={item.title}
                                messages={item.messages}
                                onRetry={handleRetry}
                              />
                            ) : (
                              <MessageBubble
                                key={item.message.id}
                                message={item.message}
                                onRetry={handleRetry}
                              />
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
                      </NowContext.Provider>
                    )}
                  </div>

                  {!atBottom && (
                    <button
                      onClick={scrollToBottom}
                      className="absolute left-1/2 z-20 flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-full border border-border-strong bg-card/90 text-secondary shadow-lg shadow-black/30 backdrop-blur transition-colors hover:bg-elevated hover:text-primary"
                      style={{ bottom: composerPadPx + 12 }}
                      title={t('chat.scrollToBottom')}
                      aria-label={t('chat.scrollToBottom')}
                    >
                      <ChevronDown size={16} />
                    </button>
                  )}

                  <div
                    ref={composerWrapRef}
                    className="pointer-events-none absolute inset-x-0 bottom-0 z-10 pb-3 pt-8 bg-gradient-to-t from-chat-column via-chat-column/80 to-transparent"
                  >
                    <div className={clsx('pointer-events-auto mx-auto w-full px-4', messageColumn)}>
                      <CouncilPanels />
                    </div>
                    {reattachedMidTurn && (
                      <div className={clsx('pointer-events-auto mx-auto mb-2 w-full px-4', messageColumn)}>
                        <div className="flex items-center gap-2.5 rounded-md bg-accent px-4 py-2.5 text-sm text-white shadow-lg shadow-black/30">
                          <Loader2 size={16} className="shrink-0 animate-spin" />
                          <span className="shrink-0 font-medium">
                            {t('chat.reattached.stillWorking', { agent: engineLabel })}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-white/80">
                            {t('chat.reattached.responseWillAppear')}
                          </span>
                        </div>
                      </div>
                    )}
                    <ChatInput dropZoneRef={chatDropZoneRef} />
                  </div>
                </>
              )
            })()}
          </div>
          {paneUnderChat && (
            <div className="flex min-h-0 flex-1 flex-col">
              {sidePanelStacked && sidePanelPane}
              {paneLayout.review === 'stacked' && <ReviewRail placement="stacked" />}
            </div>
          )}
        </div>

        {paneLayout.sidePanel === 'beside' && sidePanelPane}
        {paneLayout.review === 'beside' && <ReviewRail placement="beside" />}
      </div>

      {/* Terminal panel */}
      <TerminalPanel />

      {/* File search modal */}
      <FileSearch isOpen={fileSearchOpen} onClose={toggleFileSearch} />
    </div>
  )
}

const EXAMPLE_PROMPTS = [
  'Explain this project structure',
  'Find all TODO comments',
  'Run the test suite',
  'Help me debug an error',
]
