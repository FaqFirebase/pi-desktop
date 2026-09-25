import { ipcMain } from 'electron'
import { homedir } from 'os'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import type { TypeSafeSaveKeyResult, TypeSafeStatus } from '../../shared/ipc-contracts'
import { TYPESAFE_API_KEY_ENV } from '../../shared/typesafe'
import { typeSafeKeyStore } from '../typesafe-key-store'
import { getTypeSafeSkillStatus, installTypeSafeSkill, removeTypeSafeSkill } from '../typesafe-skill'
import { assertTrustedSender } from './validation'
import { appLog } from '../app-log'

/**
 * TypeSafe (Jev) settings: the saved API key and the agent skill. No handler
 * ever returns the key; the renderer only learns whether one exists.
 */
export function registerTypeSafeHandlers(): void {
  async function buildStatus(): Promise<TypeSafeStatus> {
    return {
      savedKey: typeSafeKeyStore.getSavedKey() !== null,
      environmentKey: Boolean(process.env[TYPESAFE_API_KEY_ENV]),
      skill: await getTypeSafeSkillStatus(homedir()),
    }
  }

  ipcMain.handle(IPC_CHANNELS.TYPESAFE_STATUS, async (event) => {
    assertTrustedSender(event)
    return buildStatus()
  })

  ipcMain.handle(IPC_CHANNELS.TYPESAFE_SAVE_KEY, async (event, key: unknown): Promise<TypeSafeSaveKeyResult> => {
    assertTrustedSender(event)
    if (!(await typeSafeKeyStore.save(key))) return { ok: false }
    return { ok: true, status: await buildStatus() }
  })

  ipcMain.handle(IPC_CHANNELS.TYPESAFE_CLEAR_KEY, async (event) => {
    assertTrustedSender(event)
    await typeSafeKeyStore.clear()
    return buildStatus()
  })

  ipcMain.handle(IPC_CHANNELS.TYPESAFE_INSTALL_SKILL, async (event) => {
    assertTrustedSender(event)
    try {
      await installTypeSafeSkill({ homeDir: homedir() })
    } catch (err) {
      appLog.error('typesafe', 'Skill install failed', err)
      throw err
    }
    return buildStatus()
  })

  ipcMain.handle(IPC_CHANNELS.TYPESAFE_REMOVE_SKILL, async (event) => {
    assertTrustedSender(event)
    await removeTypeSafeSkill(homedir())
    return buildStatus()
  })
}
