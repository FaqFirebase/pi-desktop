import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import { QUICK_CHAT_CHANNELS, type QuickChatUpdate } from '../../shared/quick-chat'
import { getQuickChatWindow } from '../quick-chat-window'
import { isString } from './validation'
import type { IpcContext } from './context'

export function registerModelHandlers(ctx: IpcContext): void {
  const { getActivePi, workspaceManager } = ctx

  const changeModelState = async (command: Record<string, unknown>) => {
    const manager = getActivePi()
    const runtimeId = workspaceManager.runtimeIdFor(manager)
    const response = await manager.sendCommand(command)
    // Main may have switched sessions while the engine was answering.
    const window = getQuickChatWindow()
    if (response?.success && runtimeId && window && !window.isDestroyed()) {
      const update: QuickChatUpdate = { type: 'runtime-state', runtimeId }
      window.webContents.send(QUICK_CHAT_CHANNELS.update, update)
    }
    return response
  }

  // ─── Model Management ───────────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.MODEL_SET, async (_event, provider: unknown, modelId: unknown) => {
    if (!isString(provider)) throw new Error('provider must be a string')
    if (!isString(modelId)) throw new Error('modelId must be a string')
    return changeModelState({ type: 'set_model', provider, modelId })
  })

  ipcMain.handle(IPC_CHANNELS.MODEL_CYCLE, async () => {
    return changeModelState({ type: 'cycle_model' })
  })

  ipcMain.handle(IPC_CHANNELS.MODEL_LIST_AVAILABLE, async () => {
    return getActivePi().sendCommand({ type: 'get_available_models' })
  })

  ipcMain.handle(IPC_CHANNELS.THINKING_SET_LEVEL, async (_event, level: unknown) => {
    if (!isString(level)) throw new Error('level must be a string')
    return changeModelState({ type: 'set_thinking_level', level })
  })

  ipcMain.handle(IPC_CHANNELS.THINKING_CYCLE_LEVEL, async () => {
    return changeModelState({ type: 'cycle_thinking_level' })
  })
}
