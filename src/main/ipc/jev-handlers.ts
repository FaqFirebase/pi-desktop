import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { JEV_JUDGE_CUA_CHANNEL, type CuaJudgment } from '../../shared/ipc-contracts'
import { typeSafeKeyStore } from '../typesafe-key-store'
import { judgeCuaUseRequest } from '../jev-cua'

/**
 * Jev (TypeSafe) judgment for Computer Use requests. The API key is read from
 * the main-process store here and never travels to the renderer; the renderer
 * only receives the typed judgment (or the confidence-0 `jev-unavailable`
 * degradation).
 */
export function registerJevHandlers(): void {
  ipcMain.handle(
    JEV_JUDGE_CUA_CHANNEL,
    async (_event: IpcMainInvokeEvent, request: unknown): Promise<CuaJudgment> => {
      if (typeof request !== 'string' || request.trim().length === 0) {
        throw new Error(`${JEV_JUDGE_CUA_CHANNEL} expects a non-empty request string`)
      }
      return judgeCuaUseRequest(request, typeSafeKeyStore.getSavedKey())
    },
  )
}
