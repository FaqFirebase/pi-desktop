import { ipcMain } from 'electron'
import { IPC_CHANNELS, isAgentEngineKind } from '../../shared/ipc-contracts'
import {
  isChatImportSource,
  type ChatImportListing,
  type ChatImportListRequest,
  type ChatImportRequest,
  type ChatImportResult,
} from '../../shared/chat-import'
import { t } from '../../shared/i18n'
import { ChatImportIndex, chatImportKey } from '../chat-import-index'
import { runChatImport } from '../chat-import-runner'
import { chatImportSourceRoot, codexSessionIndexPath, listImportableChats } from '../chat-import-sources'
import { getConfiguredEngineKind } from '../pi-rpc-manager'
import type { IpcContext } from './context'
import { isObject, isString } from './validation'

/** The most chat files one import run takes. */
export const MAX_IMPORT_PATHS_PER_RUN = 1000

export function parseChatImportListRequest(input: unknown): ChatImportListRequest {
  if (!isObject(input) || !isChatImportSource(input.source)) throw new Error('Chat import source must be claude-code or codex')
  if (input.engine === undefined) return { source: input.source }
  if (!isAgentEngineKind(input.engine)) throw new Error('Chat import engine must be pi or omp')
  return { source: input.source, engine: input.engine }
}

export function parseChatImportRequest(input: unknown): ChatImportRequest {
  if (!isObject(input) || !isChatImportSource(input.source)) throw new Error('Chat import source must be claude-code or codex')
  if (!isAgentEngineKind(input.engine)) throw new Error('Chat import engine must be pi or omp')
  const { sourcePaths } = input
  if (!Array.isArray(sourcePaths) || !sourcePaths.every(isString)) throw new Error('Chat import paths must be strings')
  if (sourcePaths.length === 0 || sourcePaths.length > MAX_IMPORT_PATHS_PER_RUN) {
    throw new Error(`Chat import takes 1 to ${MAX_IMPORT_PATHS_PER_RUN} paths`)
  }
  return { source: input.source, engine: input.engine, sourcePaths: [...sourcePaths] }
}

export function registerChatImportHandlers(ctx: IpcContext): void {
  const index = new ChatImportIndex()
  let running = false

  ipcMain.handle(IPC_CHANNELS.CHAT_IMPORT_LIST, async (event, input: unknown): Promise<ChatImportListing> => {
    ctx.assertMainSender(event)
    const request = parseChatImportListRequest(input)
    const engine = request.engine ?? getConfiguredEngineKind()
    const sourceRoot = chatImportSourceRoot(request.source)
    const items = await listImportableChats(
      request.source,
      sourceRoot,
      async (sourceSessionId) => (await index.importedPath(chatImportKey(engine, request.source, sourceSessionId))) !== null,
      codexSessionIndexPath(),
    )
    return { source: request.source, engine, sourceRoot, items }
  })

  ipcMain.handle(IPC_CHANNELS.CHAT_IMPORT_RUN, async (event, input: unknown): Promise<ChatImportResult> => {
    ctx.assertMainSender(event)
    const request = parseChatImportRequest(input)
    if (running) throw new Error(t('errors.chatImport.busy'))
    running = true
    try {
      return await runChatImport({
        request,
        sourceRoot: chatImportSourceRoot(request.source),
        codexIndexPath: codexSessionIndexPath(),
        index,
        onProgress: (progress) => ctx.broadcast(IPC_CHANNELS.EVENT_CHAT_IMPORT_PROGRESS, progress),
      })
    } finally {
      running = false
    }
  })
}
