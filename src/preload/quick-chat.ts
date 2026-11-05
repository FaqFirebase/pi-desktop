import { contextBridge, ipcRenderer } from 'electron'
import { QUICK_CHAT_CHANNELS, type QuickChatApi, type QuickChatUpdate } from '../shared/quick-chat'

const api: QuickChatApi = {
  getContext: () => ipcRenderer.invoke(QUICK_CHAT_CHANNELS.context),
  selectTarget: (target) => ipcRenderer.invoke(QUICK_CHAT_CHANNELS.select, target),
  createSession: (workspaceId) => ipcRenderer.invoke(QUICK_CHAT_CHANNELS.createSession, workspaceId),
  newDraft: () => ipcRenderer.invoke(QUICK_CHAT_CHANNELS.newDraft),
  pickWorkspace: () => ipcRenderer.invoke(QUICK_CHAT_CHANNELS.pickWorkspace),
  resolveHomeWorkspace: () => ipcRenderer.invoke(QUICK_CHAT_CHANNELS.resolveHomeWorkspace),
  stop: (version) => ipcRenderer.invoke(QUICK_CHAT_CHANNELS.stop, version),
  getSnapshot: (version) => ipcRenderer.invoke(QUICK_CHAT_CHANNELS.snapshot, version),
  submitText: (input) => ipcRenderer.invoke(QUICK_CHAT_CHANNELS.submit, input),
  respond: (input) => ipcRenderer.invoke(QUICK_CHAT_CHANNELS.respond, input),
  listModels: (workspaceId) => ipcRenderer.invoke(QUICK_CHAT_CHANNELS.listModels, workspaceId),
  setRuntimeModel: (input) => ipcRenderer.invoke(QUICK_CHAT_CHANNELS.setRuntimeModel, input),
  setRuntimeThinking: (input) => ipcRenderer.invoke(QUICK_CHAT_CHANNELS.setRuntimeThinking, input),
  setPinned: (pinned) => ipcRenderer.invoke(QUICK_CHAT_CHANNELS.setPinned, { pinned }),
  hide: () => ipcRenderer.invoke(QUICK_CHAT_CHANNELS.hide),
  pickAttachment: () => ipcRenderer.invoke(QUICK_CHAT_CHANNELS.pickAttachment),
  openInMain: () => ipcRenderer.invoke(QUICK_CHAT_CHANNELS.openInMain),
  onUpdate: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, update: QuickChatUpdate): void => callback(update)
    ipcRenderer.on(QUICK_CHAT_CHANNELS.update, listener)
    return () => { ipcRenderer.removeListener(QUICK_CHAT_CHANNELS.update, listener) }
  },
}

contextBridge.exposeInMainWorld('piQuickChat', api)
