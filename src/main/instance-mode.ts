import { readFileSync, renameSync, writeFileSync } from 'fs'
import { DEFAULT_SETTINGS } from '../shared/default-settings'
import { isEnvFlagOn } from './env-flag'

/**
 * Multiple Pi Desktop instances, opt-in.
 *
 * By default one Pi Desktop runs at a time: a second launch focuses the first
 * window, whatever data folder it was given. With multiple instances allowed,
 * Pi Desktop windows that use different data folders (PI_DESKTOP_USER_DATA_DIR)
 * run side by side, for example one per account started by a launcher. Two
 * launches on the same data folder still fold into one: two processes sharing
 * one folder would overwrite each other's files.
 *
 * Electron keys its single-instance lock on the `userData` path at the moment
 * the lock is requested, so the mode is applied through the order of startup:
 * multiple instances apply the data folder first (one lock per folder); a single
 * instance takes the lock first (one lock for every folder).
 */

/** Set to `1` or `true` by a host (such as a launcher) to allow multiple instances. */
export const ALLOW_MULTIPLE_INSTANCES_ENV_VAR = 'PI_DESKTOP_ALLOW_MULTIPLE_INSTANCES'

/** True when the environment asks for multiple instances. */
export function multipleInstancesRequestedByEnv(env: NodeJS.ProcessEnv): boolean {
  return isEnvFlagOn(env[ALLOW_MULTIPLE_INSTANCES_ENV_VAR])
}

/**
 * The `allowMultipleInstances` setting of the data folder whose settings file
 * is `settingsPath`, read before the app is ready. A missing or unreadable file,
 * or a value that is not a boolean, reads as the default (off).
 */
export function readAllowMultipleInstancesSync(settingsPath: string): boolean {
  try {
    const stored = JSON.parse(readFileSync(settingsPath, 'utf-8')) as { allowMultipleInstances?: unknown }
    if (typeof stored.allowMultipleInstances === 'boolean') return stored.allowMultipleInstances
  } catch {
    // Fall through to the default.
  }
  return DEFAULT_SETTINGS.allowMultipleInstances
}

/**
 * Save `allowMultipleInstances: true` into a data folder's settings file, so
 * every later launch of that folder takes the same per-folder lock whether or
 * not it carries the environment flag. Without this, a folder first opened by
 * a launcher (flag set) and then directly (flag unset) would be locked two
 * different ways and could run twice. A settings file that is not a JSON object
 * is left untouched: the app's own settings handling deals with it.
 */
export function persistAllowMultipleInstancesSync(settingsPath: string): void {
  let stored: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
    stored = parsed as Record<string, unknown>
  } catch (err) {
    // A missing file starts empty; an unreadable or malformed one is kept as is.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return
  }
  if (stored.allowMultipleInstances === true) return
  const temporaryPath = `${settingsPath}.tmp-${process.pid}`
  writeFileSync(temporaryPath, JSON.stringify({ ...stored, allowMultipleInstances: true }, null, 2), 'utf-8')
  renameSync(temporaryPath, settingsPath)
}

/**
 * Whether this launch runs as one of several instances: the environment flag
 * (which is then saved into the folder, see persistAllowMultipleInstancesSync)
 * or the folder's own setting.
 */
export function resolveMultipleInstances(env: NodeJS.ProcessEnv, settingsPath: string): boolean {
  if (multipleInstancesRequestedByEnv(env)) {
    try {
      persistAllowMultipleInstancesSync(settingsPath)
    } catch {
      // Not saving only weakens the same-folder guarantee for later launches
      // without the flag; this launch still runs as requested.
    }
    return true
  }
  return readAllowMultipleInstancesSync(settingsPath)
}
