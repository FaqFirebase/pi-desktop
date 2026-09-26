import { ipcMain } from 'electron'
import { homedir } from 'os'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import type { TypeSafeSaveKeyResult, TypeSafeStatus } from '../../shared/ipc-contracts'
import { OPENROUTER_API_KEY_ENV, TYPESAFE_API_KEY_ENV } from '../../shared/typesafe'
import { openRouterKeyStore, typeSafeKeyStore } from '../typesafe-key-store'
import { getTypeSafeSkillStatus, installTypeSafeSkill, removeTypeSafeSkill } from '../typesafe-skill'
import { assertTrustedSender } from './validation'
import { appLog } from '../app-log'

function keyStore(provider: unknown) {
  if (provider === 'typesafe') return typeSafeKeyStore
  if (provider === 'openrouter') return openRouterKeyStore
  throw new Error('Invalid Jev key provider')
}

/** Jev key handlers return only key presence, never saved credentials. */
export function registerTypeSafeHandlers(): void {
  async function buildStatus(): Promise<TypeSafeStatus> {
    return {
      savedKey: typeSafeKeyStore.getSavedKey() !== null,
      environmentKey: Boolean(process.env[TYPESAFE_API_KEY_ENV]),
      openrouter: {
        savedKey: openRouterKeyStore.getSavedKey() !== null,
        environmentKey: Boolean(process.env[OPENROUTER_API_KEY_ENV]),
      },
      skill: await getTypeSafeSkillStatus(homedir()),
    }
  }

  ipcMain.handle(IPC_CHANNELS.TYPESAFE_STATUS, async (event) => {
    assertTrustedSender(event)
    return buildStatus()
  })

  ipcMain.handle(IPC_CHANNELS.TYPESAFE_SAVE_KEY, async (event, key: unknown, provider: unknown): Promise<TypeSafeSaveKeyResult> => {
    assertTrustedSender(event)
    if (!(await keyStore(provider).save(key))) return { ok: false }
    return { ok: true, status: await buildStatus() }
  })

  ipcMain.handle(IPC_CHANNELS.TYPESAFE_CLEAR_KEY, async (event, provider: unknown) => {
    assertTrustedSender(event)
    await keyStore(provider).clear()
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
