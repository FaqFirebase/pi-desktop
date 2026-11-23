import { TYPESAFE_API_KEY_ENV } from '../shared/typesafe'
import { getGuiDataPath } from './app-data-paths'
import { ApiKeyStore } from './api-key-store'

const TYPESAFE_KEY_FILE = 'typesafe-api-key'

/** The user's TypeSafe API key. The path resolves on use: the data directory is configured during startup. */
export const typeSafeKeyStore = new ApiKeyStore(() => getGuiDataPath(TYPESAFE_KEY_FILE))

/**
 * The environment additions that give an agent process the saved key. A key
 * already set in the inherited environment wins, so a developer's shell value
 * is never overridden.
 */
export function typeSafeKeyEnv(
  savedKey: string | null,
  inherited: NodeJS.ProcessEnv,
): Record<string, string> {
  if (!savedKey || inherited[TYPESAFE_API_KEY_ENV]) return {}
  return { [TYPESAFE_API_KEY_ENV]: savedKey }
}
