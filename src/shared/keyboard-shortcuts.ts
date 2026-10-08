export const SHORTCUT_ACTIONS = [
  'modelSelector', 'sidebar', 'files', 'diff', 'terminal', 'review',
  'newSession', 'previousProject', 'nextProject', 'previousSession', 'nextSession',
  'commitPush', 'settings', 'commandPalette', 'notes', 'pushToTalk', 'globalDictation',
] as const
export type ShortcutAction = typeof SHORTCUT_ACTIONS[number]
export type KeyboardShortcuts = Record<ShortcutAction, string | null>

export const DEFAULT_KEYBOARD_SHORTCUTS: KeyboardShortcuts = {
  diff: 'Mod+G',
  terminal: 'Ctrl+Backquote',
  settings: 'Mod+Comma',
  commandPalette: 'Mod+K',
  modelSelector: 'Mod+Shift+M',
  notes: 'Ctrl+Shift+P',
  // Not Meta: that is the Super/Windows key outside macOS, and Super+P is the
  // system display switcher there. Clear of the editor's and terminal's keys.
  commitPush: 'Mod+Shift+H',
  sidebar: 'Mod+B',
  files: 'Mod+Shift+E',
  review: 'Mod+Shift+U',
  newSession: 'Mod+N',
  previousProject: 'Mod+Shift+BracketLeft',
  nextProject: 'Mod+Shift+BracketRight',
  previousSession: 'Mod+BracketLeft',
  nextSession: 'Mod+BracketRight',
  // Hold to dictate into the composer while the app has focus.
  pushToTalk: 'Mod+Shift+T',
  // Off until the user picks one: a system-wide key is taken from every other app.
  globalDictation: null,
}

export interface ShortcutKeyEvent {
  key: string
  code?: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  isComposing?: boolean
  keyCode?: number
}

const MODIFIERS = ['Mod', 'Ctrl', 'Meta', 'Alt', 'Shift']
const PUNCTUATION: Record<string, string> = {
  '`': 'Backquote', ',': 'Comma', '.': 'Period', '/': 'Slash', '\\': 'Backslash',
  '[': 'BracketLeft', ']': 'BracketRight', '-': 'Minus', '=': 'Equal', ';': 'Semicolon', "'": 'Quote',
}
const KEY_CHARACTERS: Record<string, string> = Object.fromEntries(
  Object.entries(PUNCTUATION).map(([character, name]) => [name, character]),
)
const MODIFIER_KEYS: Record<string, string> = { Control: 'Ctrl', Meta: 'Meta', Alt: 'Alt', Shift: 'Shift' }
// Electron accelerator names; Super is Cmd on macOS and the Super/Windows key elsewhere.
const ACCELERATOR_MODIFIERS: Record<string, string> = {
  Mod: 'CommandOrControl', Ctrl: 'Control', Meta: 'Super', Alt: 'Alt', Shift: 'Shift',
}
const KEY_PATTERN = /^(?:[A-Z0-9]|F(?:[1-9]|1[0-2])|Backquote|Comma|Period|Slash|Backslash|BracketLeft|BracketRight|Minus|Equal|Semicolon|Quote)$/

function parseShortcut(value: unknown): string[] | null {
  if (typeof value !== 'string') return null
  const parts = value.split('+')
  const key = parts.at(-1)!
  const modifiers = parts.slice(0, -1)
  if (!KEY_PATTERN.test(key) || !modifiers.length || new Set(parts).size !== parts.length) return null
  if (modifiers.some((part) => !MODIFIERS.includes(part))) return null
  if (!modifiers.some((part) => ['Mod', 'Ctrl', 'Meta'].includes(part))) return null
  if (modifiers.includes('Mod') && (modifiers.includes('Ctrl') || modifiers.includes('Meta'))) return null
  return [...MODIFIERS.filter((part) => modifiers.includes(part)), key]
}

function resolvedShortcut(value: string, platform: string): string {
  return parseShortcut(value)!.map((part) => part === 'Mod' ? platform === 'darwin' ? 'Meta' : 'Ctrl' : part).join('+')
}

function eventKey(event: ShortcutKeyEvent): string {
  if (/^Key[A-Z]$/.test(event.code ?? '')) return event.code!.slice(3)
  if (/^Digit[0-9]$/.test(event.code ?? '')) return event.code!.slice(5)
  if (event.code && KEY_PATTERN.test(event.code)) return event.code
  return PUNCTUATION[event.key] ?? event.key.toUpperCase()
}

export function matchesShortcut(event: ShortcutKeyEvent, binding: string | null, platform: string): boolean {
  if (!binding || event.isComposing || event.keyCode === 229) return false
  const parts = parseShortcut(binding)
  if (!parts) return false
  const resolved = resolvedShortcut(binding, platform).split('+')
  return event.ctrlKey === resolved.includes('Ctrl') && event.metaKey === resolved.includes('Meta')
    && event.altKey === resolved.includes('Alt') && event.shiftKey === resolved.includes('Shift')
    && eventKey(event) === resolved.at(-1)
}

/** True when letting go of this key ends a held `binding`: its main key or one of its modifiers. */
export function releasesShortcut(event: ShortcutKeyEvent, binding: string, platform: string): boolean {
  if (!parseShortcut(binding)) return false
  const resolved = resolvedShortcut(binding, platform).split('+')
  const modifier = MODIFIER_KEYS[event.key]
  return modifier ? resolved.includes(modifier) : eventKey(event) === resolved.at(-1)
}

/** The Electron accelerator for a stored binding, or null when the binding is malformed. */
export function shortcutAccelerator(binding: string): string | null {
  const parts = parseShortcut(binding)
  if (!parts) return null
  const key = parts.at(-1)!
  return [...parts.slice(0, -1).map((part) => ACCELERATOR_MODIFIERS[part]), KEY_CHARACTERS[key] ?? key].join('+')
}

/** Store the platform's primary modifier portably, but keep Ctrl distinct on macOS. */
export function captureShortcut(event: ShortcutKeyEvent, platform: string): string | null {
  if (event.isComposing || event.keyCode === 229 || (!event.ctrlKey && !event.metaKey)) return null
  const key = eventKey(event)
  if (!KEY_PATTERN.test(key)) return null
  const primary = platform === 'darwin' ? event.metaKey : event.ctrlKey
  const secondary = platform === 'darwin' ? event.ctrlKey : event.metaKey
  const parts = primary && !secondary ? ['Mod'] : [event.ctrlKey ? 'Ctrl' : '', event.metaKey ? 'Meta' : ''].filter(Boolean)
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  return [...parts, key].join('+')
}

// Native menu, editing, and chat search/model cycling stay fixed.
const RESERVED_SHORTCUTS = [
  'Mod+Shift+N', 'Mod+O', 'Mod+Q', 'Mod+W', 'Mod+M',
  'Mod+R', 'Mod+Shift+R', 'Mod+Alt+I', 'Ctrl+Shift+I',
  'Mod+Z', 'Mod+Shift+Z', 'Mod+Y', 'Mod+X', 'Mod+C', 'Mod+V', 'Mod+Shift+V', 'Mod+A',
  'Mod+S', 'Mod+F', 'Ctrl+P', 'Mod+Equal', 'Mod+Shift+Equal', 'Mod+Minus', 'Mod+0',
]

export type ShortcutProblem = { kind: 'invalid' | 'reserved'; action: ShortcutAction }
  | { kind: 'duplicate'; action: ShortcutAction; other: ShortcutAction }

export function shortcutProblem(shortcuts: KeyboardShortcuts, platform: string): ShortcutProblem | null {
  const seen = new Map<string, ShortcutAction>()
  const reserved = new Set(RESERVED_SHORTCUTS.map((binding) => resolvedShortcut(binding, platform)))
  for (const action of SHORTCUT_ACTIONS) {
    const binding = shortcuts[action]
    if (binding === null) continue
    if (!parseShortcut(binding)) return { kind: 'invalid', action }
    const resolved = resolvedShortcut(binding, platform)
    if (reserved.has(resolved)) return { kind: 'reserved', action }
    const other = seen.get(resolved)
    if (other) return { kind: 'duplicate', action, other }
    seen.set(resolved, action)
  }
  return null
}

/** The action that already uses the binding recorded for `action`, when the problem is that duplicate. */
export function duplicateShortcutOwner(problem: ShortcutProblem | null, action: ShortcutAction): ShortcutAction | null {
  if (problem?.kind !== 'duplicate') return null
  if (problem.action === action) return problem.other
  return problem.other === action ? problem.action : null
}

/** Settings files may predate individual actions; malformed bindings never reach the dispatcher. */
export function normalizeKeyboardShortcuts(value: unknown): KeyboardShortcuts {
  const result = { ...DEFAULT_KEYBOARD_SHORTCUTS }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  for (const action of SHORTCUT_ACTIONS) {
    const binding = (value as Record<string, unknown>)[action]
    const parsed = parseShortcut(binding)
    if (binding === null || parsed) result[action] = parsed?.join('+') ?? null
  }
  return result
}

export function formatShortcut(binding: string, platform: string): string {
  const labels: Record<string, string> = { Meta: platform === 'darwin' ? 'Cmd' : 'Meta', ...KEY_CHARACTERS }
  return resolvedShortcut(binding, platform).split('+').map((part) => labels[part] ?? part).join('+')
}
