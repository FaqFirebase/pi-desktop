import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import { isString } from './validation'
import type { IpcContext } from './context'

export function registerTagHandlers(ctx: IpcContext): void {
  const { tagManager } = ctx

  // ─── Session Tags ───────────────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.TAG_GET, async (_event, sessionId: unknown) => {
    if (!isString(sessionId)) throw new Error('sessionId must be a string')
    return tagManager.getTags(sessionId)
  })

  ipcMain.handle(IPC_CHANNELS.TAG_SET, async (_event, sessionId: unknown, tags: unknown) => {
    if (!isString(sessionId)) throw new Error('sessionId must be a string')
    if (!Array.isArray(tags)) throw new Error('tags must be an array')
    await tagManager.setTags(sessionId, tags.map(String))
    return tagManager.getTags(sessionId)
  })

  ipcMain.handle(IPC_CHANNELS.TAG_ADD, async (_event, sessionId: unknown, tag: unknown) => {
    if (!isString(sessionId)) throw new Error('sessionId must be a string')
    if (!isString(tag)) throw new Error('tag must be a string')
    return tagManager.addTag(sessionId, tag)
  })

  ipcMain.handle(IPC_CHANNELS.TAG_REMOVE, async (_event, sessionId: unknown, tag: unknown) => {
    if (!isString(sessionId)) throw new Error('sessionId must be a string')
    if (!isString(tag)) throw new Error('tag must be a string')
    return tagManager.removeTag(sessionId, tag)
  })

  ipcMain.handle(IPC_CHANNELS.TAG_GET_ALL, async () => {
    return tagManager.getAllTags()
  })

  ipcMain.handle(IPC_CHANNELS.TAG_GET_ALL_USED, async () => {
    return tagManager.getAllUsedTags()
  })

  ipcMain.handle(IPC_CHANNELS.TAG_AUTO_GET_ALL, async () => {
    return tagManager.getAutoTags()
  })

  ipcMain.handle(IPC_CHANNELS.TAG_AUTO_ENSURE, async (_event, sessions: unknown) => {
    if (!Array.isArray(sessions)) throw new Error('sessions must be an array')
    const refs: Array<{ sessionId: string; path: string }> = []
    for (const s of sessions) {
      if (
        typeof s === 'object' && s !== null &&
        isString((s as { sessionId?: unknown }).sessionId) &&
        isString((s as { path?: unknown }).path)
      ) {
        refs.push({
          sessionId: (s as { sessionId: string }).sessionId,
          path: (s as { path: string }).path,
        })
      }
    }
    return tagManager.ensureAutoTags(refs)
  })

  ipcMain.handle(IPC_CHANNELS.TAG_AUTO_REMOVE, async (_event, sessionId: unknown) => {
    if (!isString(sessionId)) throw new Error('sessionId must be a string')
    await tagManager.removeAutoTag(sessionId)
  })
}
