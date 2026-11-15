/** Every editor the app can find and open files in (main + renderer). */
export const EDITOR_IDS = [
  'vscode',
  'vscode-insiders',
  'vscodium',
  'cursor',
  'windsurf',
  'zed',
  'sublime',
  'intellij-idea',
  'pycharm',
  'webstorm',
  'goland',
  'rider',
  'clion',
  'rustrover',
  'phpstorm',
  'rubymine',
  'datagrip',
  'neovim',
  'vim',
  'helix',
  'neovide',
] as const

export type EditorId = typeof EDITOR_IDS[number]

export function isEditorId(value: unknown): value is EditorId {
  return typeof value === 'string' && (EDITOR_IDS as readonly string[]).includes(value)
}

/** An editor found on this computer. `inTerminal` editors run in the app's terminal panel. */
export interface DetectedEditor {
  id: EditorId
  name: string
  inTerminal: boolean
}

export type OpenPathAction = 'editor' | 'system' | 'reveal'

export const OPEN_PATH_ACTIONS: readonly OpenPathAction[] = ['editor', 'system', 'reveal']

export function isOpenPathAction(value: unknown): value is OpenPathAction {
  return typeof value === 'string' && (OPEN_PATH_ACTIONS as readonly string[]).includes(value)
}

export interface OpenPathRequest {
  action: OpenPathAction
  path: string
  /** 1-based line to place the cursor on; used for files only. */
  line?: number
}

export type OpenPathRefusal =
  | 'outside-roots'
  | 'not-found'
  | 'runnable-file'
  | 'launch-failed'
  | 'system-open-failed'
  | 'no-terminal-workspace'
  | 'editor-running'

/**
 * `editorTerminalWorkspaceId` names the workspace whose editor terminal slot to
 * show: one a terminal editor was prepared in, or the one an `editor-running`
 * refusal points at.
 */
export type OpenPathResult =
  | { ok: true; editorTerminalWorkspaceId: string | null }
  | { ok: false; refusal: OpenPathRefusal; editorTerminalWorkspaceId?: string }

/**
 * The editor "Open in editor" uses. A saved editor that is no longer installed
 * falls back to the system default (`editor: null`) and is reported `missing`.
 */
export function resolvePreferredEditor(
  preferred: EditorId | null,
  detected: readonly DetectedEditor[],
): { editor: DetectedEditor | null; missing: boolean } {
  if (preferred === null) return { editor: null, missing: false }
  const editor = detected.find((candidate) => candidate.id === preferred) ?? null
  return { editor, missing: editor === null }
}
