/**
 * Optional window hints from the environment, for a host that starts several
 * Pi Desktop instances (for example one per account) and needs to tell them
 * apart. Off unless set; read once at startup.
 *
 * - PI_DESKTOP_WINDOW_TITLE: a label appended to the window title,
 *   "Pi Desktop — <label>". The title shows in the taskbar, the Dock menu,
 *   window switchers and window lists on every platform and session. The
 *   tray icon's tooltip gets the same label.
 */

export const WINDOW_TITLE_ENV_VAR = 'PI_DESKTOP_WINDOW_TITLE'

const MAX_TITLE_LABEL_LENGTH = 80
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g
const TITLE_SEPARATOR = ' — '

export interface WindowHints {
  /** Label appended to the window title. */
  titleLabel?: string
}

/** The hints set in `env`; a value that is empty after clean-up is ignored. */
export function readWindowHints(env: NodeJS.ProcessEnv): WindowHints {
  const hints: WindowHints = {}
  const label = env[WINDOW_TITLE_ENV_VAR]?.replace(CONTROL_CHARACTERS, ' ').trim().slice(0, MAX_TITLE_LABEL_LENGTH).trim()
  if (label) hints.titleLabel = label
  return hints
}

/** `title` with the instance label appended, when there is one. */
export function windowTitle(title: string, hints: WindowHints): string {
  return hints.titleLabel ? `${title}${TITLE_SEPARATOR}${hints.titleLabel}` : title
}
