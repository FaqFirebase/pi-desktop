import type { PiExtensionUiRequest, PiProcessStatus, PiRpcEvent } from '../shared/ipc-contracts'

/** Extension UI that stops the turn until the user answers. */
const USER_PROMPT_METHODS: ReadonlySet<PiExtensionUiRequest['method']> = new Set(['select', 'confirm', 'input', 'editor'])

/** Statuses of a live process; any other status means the process is gone. */
const LIVE_STATUSES: ReadonlySet<PiProcessStatus> = new Set(['running', 'starting'])

export interface RuntimeTurnState {
  /** Each handler returns whether `isRunningTurn()` changed. */
  handleEvent(event: PiRpcEvent): boolean
  handleUiResponse(requestId: string): boolean
  handleStatus(status: PiProcessStatus): boolean
  handleExit(): boolean
  /** A turn runs and does not wait on the user. */
  isRunningTurn(): boolean
}

/**
 * Whether one agent runtime runs a turn now. A turn with an open user prompt
 * does not count: it only waits, and sleep only pauses it. The events and the
 * prompt rule are the ones `WorkspaceManager.attachSessionRuntime` follows, so
 * "waits on the user" means the same thing in both places.
 */
export function createRuntimeTurnState(): RuntimeTurnState {
  let turnActive = false
  const openPrompts = new Set<string>()

  const isRunningTurn = (): boolean => turnActive && openPrompts.size === 0

  const track = (change: () => void): boolean => {
    const before = isRunningTurn()
    change()
    return isRunningTurn() !== before
  }

  const endTurn = (): void => {
    turnActive = false
    openPrompts.clear()
  }

  return {
    isRunningTurn,

    handleEvent(event) {
      return track(() => {
        if (event.type === 'agent_start') turnActive = true
        else if (event.type === 'agent_end') endTurn()
        else if (event.type === 'extension_ui_request') {
          if (USER_PROMPT_METHODS.has(event.method)) openPrompts.add(event.id)
          else if (event.method === 'cancel' && event.targetId) openPrompts.delete(event.targetId)
        }
      })
    },

    handleUiResponse(requestId) {
      return track(() => openPrompts.delete(requestId))
    },

    handleStatus(status) {
      return track(() => {
        if (!LIVE_STATUSES.has(status)) endTurn()
      })
    },

    handleExit() {
      return track(endTurn)
    },
  }
}
