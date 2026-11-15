import { ipcMain } from 'electron'
import { IPC_CHANNELS, type GitAvailability } from '../../shared/ipc-contracts'
import { createGitAvailabilityCache, probeGitAvailability } from '../git-availability'
import { getPiResolution } from '../pi-rpc-manager'
import type { IpcContext } from './context'

// The Pi resolution adopts the login-shell PATH into process.env, so git
// found only on the shell PATH (a desktop-launcher start) counts as found.
const gitAvailability = createGitAvailabilityCache(async () => {
  getPiResolution()
  return probeGitAvailability()
})

/** Cached result of the startup git check or the last Check again. */
export function getGitAvailability(): Promise<GitAvailability> {
  return gitAvailability.get()
}

export function registerGitAvailabilityHandlers(ctx: IpcContext): void {
  ipcMain.handle(IPC_CHANNELS.GIT_AVAILABILITY_GET, (event) => {
    ctx.assertMainSender(event)
    return gitAvailability.get()
  })
  ipcMain.handle(IPC_CHANNELS.GIT_AVAILABILITY_RECHECK, (event) => {
    ctx.assertMainSender(event)
    return gitAvailability.recheck()
  })
}
