import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import { isString } from './validation'
import type { IpcContext } from './context'

export function registerModelHandlers(ctx: IpcContext): void {
  const { getActivePi } = ctx

  // ─── Model Management ───────────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.MODEL_SET, async (_event, provider: unknown, modelId: unknown) => {
    if (!isString(provider)) throw new Error('provider must be a string')
    if (!isString(modelId)) throw new Error('modelId must be a string')
    return getActivePi().sendCommand({ type: 'set_model', provider, modelId })
  })

  ipcMain.handle(IPC_CHANNELS.MODEL_CYCLE, async () => {
    return getActivePi().sendCommand({ type: 'cycle_model' })
  })

  ipcMain.handle(IPC_CHANNELS.MODEL_LIST_AVAILABLE, async () => {
    return getActivePi().sendCommand({ type: 'get_available_models' })
  })

  ipcMain.handle(IPC_CHANNELS.THINKING_SET_LEVEL, async (_event, level: unknown) => {
    if (!isString(level)) throw new Error('level must be a string')
    return getActivePi().sendCommand({ type: 'set_thinking_level', level })
  })

  ipcMain.handle(IPC_CHANNELS.THINKING_CYCLE_LEVEL, async () => {
    return getActivePi().sendCommand({ type: 'cycle_thinking_level' })
  })
}
