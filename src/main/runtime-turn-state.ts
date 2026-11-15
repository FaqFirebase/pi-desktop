import { BLOCKING_UI_METHODS, type PiProcessStatus, type PiRpcEvent } from '../shared/ipc-contracts'

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
 * prompt rule (`BLOCKING_UI_METHODS`) are the ones `WorkspaceManager.attachSessionRuntime`
 * follows, so "waits on the user" means the same thing in both places.
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
          if (BLOCKING_UI_METHODS.has(event.method)) openPrompts.add(event.id)
          else if (event.method === 'cancel' && event.targetId) openPrompts.delete(event.targetId)
        }
      })
    },

    handleUiResponse(requestId) {
      return track(() => openPrompts.delete(requestId))
    },

    handleStatus(status) {
      // Any status but 'running' means the process is gone or a new one
      // starts (a restart moves straight to 'starting' with no exit event).
      return track(() => {
        if (status !== 'running') endTurn()
      })
    },

    handleExit() {
      return track(endTurn)
    },
  }
}
