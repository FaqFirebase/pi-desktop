import { isEnvFlagOn } from './env-flag'

/**
 * Optional window hints from the environment, for a host that starts several
 * Pi Desktop instances (for example one per account) and needs to tell them
 * apart or lay them out. All are off unless set; read once at startup.
 *
 * - PI_DESKTOP_WINDOW_TITLE: a label appended to the window title,
 *   "Pi Desktop — <label>".
 * - PI_DESKTOP_APP_USER_MODEL_ID: the Windows AppUserModelID, so each instance
 *   gets its own taskbar button and notification identity.
 * - PI_DESKTOP_FRAMELESS: a window without the OS frame or a taskbar button,
 *   for a host that positions the window itself.
 */

export const WINDOW_TITLE_ENV_VAR = 'PI_DESKTOP_WINDOW_TITLE'
export const APP_USER_MODEL_ID_ENV_VAR = 'PI_DESKTOP_APP_USER_MODEL_ID'
export const FRAMELESS_ENV_VAR = 'PI_DESKTOP_FRAMELESS'

/** The AppUserModelID the app uses without a hint. */
export const DEFAULT_APP_USER_MODEL_ID = 'dev.pi.desktop-gui'

const MAX_TITLE_LABEL_LENGTH = 80
// Windows limits an AppUserModelID to 128 characters, without spaces.
const APP_USER_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g
const TITLE_SEPARATOR = ' — '

export interface WindowHints {
  /** Label appended to the window title. */
  titleLabel?: string
  /** Windows AppUserModelID for this instance. */
  appUserModelId?: string
  /** Create the window without the OS frame and taskbar button. */
  frameless: boolean
}

/** The hints set in `env`; a value that is empty or malformed is ignored. */
export function readWindowHints(env: NodeJS.ProcessEnv): WindowHints {
  const hints: WindowHints = { frameless: isEnvFlagOn(env[FRAMELESS_ENV_VAR]) }
  const label = env[WINDOW_TITLE_ENV_VAR]?.replace(CONTROL_CHARACTERS, ' ').trim().slice(0, MAX_TITLE_LABEL_LENGTH).trim()
  if (label) hints.titleLabel = label
  const appUserModelId = env[APP_USER_MODEL_ID_ENV_VAR]?.trim()
  if (appUserModelId && APP_USER_MODEL_ID_PATTERN.test(appUserModelId)) hints.appUserModelId = appUserModelId
  return hints
}

/** `title` with the instance label appended, when there is one. */
export function windowTitle(title: string, hints: Pick<WindowHints, 'titleLabel'>): string {
  return hints.titleLabel ? `${title}${TITLE_SEPARATOR}${hints.titleLabel}` : title
}
