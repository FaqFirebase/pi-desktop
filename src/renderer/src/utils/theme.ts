import type { ThemeFile } from '../../../shared/theme/theme-file'
import { resolveThemeVars } from '../../../shared/theme/resolve'
import { BUILTIN_THEMES } from '../themes'
import { applyThemeVars } from '../theme/engine'

export interface RegisteredTheme { id: string; file: ThemeFile }

const BUILTIN_IDS = new Set(BUILTIN_THEMES.map((t) => t.id))
const registry = new Map<string, ThemeFile>(BUILTIN_THEMES.map((t) => [t.id, t.file]))
let appliedVarKeys: string[] = []

// Additive: adds or updates the given themes. Use for a single fresh
// add/update (import, URL install, editor save) where nothing needs removing.
export function registerThemes(themes: ReadonlyArray<RegisteredTheme>): void {
  for (const theme of themes) registry.set(theme.id, theme.file)
}

// Authoritative reconcile against the full user-theme set from themes.list():
// drops every current user (non-built-in) entry, then re-adds the given ones,
// so a deleted or renamed-away theme leaves the dropdown without an app
// restart. Built-in entries are never touched.
export function setUserThemes(themes: ReadonlyArray<RegisteredTheme>): void {
  for (const id of [...registry.keys()]) {
    if (!BUILTIN_IDS.has(id)) registry.delete(id)
  }
  for (const theme of themes) registry.set(theme.id, theme.file)
}

export function getRegisteredThemes(): ReadonlyArray<RegisteredTheme> {
  return [...registry.entries()].map(([id, file]) => ({ id, file }))
}

let systemThemeWatched = false
let previewActive = false

// While a live preview owns the document's theme variables (the theme editor),
// external re-applies must yield or they overwrite the unsaved preview. The
// editor sets this for its lifetime; watchSystemTheme checks it.
export function setThemePreviewActive(active: boolean): void {
  previewActive = active
}

// Re-applies the theme when the OS light/dark preference changes while the
// app is open, but only when the currently-effective theme is 'system' and no
// live preview is in progress. Subscribes once for the app's lifetime;
// repeated calls are no-ops.
export function watchSystemTheme(getEffectiveThemeId: () => string): void {
  if (systemThemeWatched) return
  systemThemeWatched = true
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (previewActive) return
    if (getEffectiveThemeId() === 'system') applyTheme('system')
  })
}

function systemThemeId(): string {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function applyTheme(themeId: string): void {
  const id = themeId === 'system' ? systemThemeId() : themeId
  const file = registry.get(id) ?? registry.get('dark')!
  const html = document.documentElement
  appliedVarKeys = applyThemeVars(html, resolveThemeVars(file), appliedVarKeys)
  html.classList.toggle('light', file.kind === 'light')
  html.style.colorScheme = file.kind
}

export function isLightTheme(themeId: string | null | undefined): boolean {
  if (!themeId) return false
  const id = themeId === 'system' ? systemThemeId() : themeId
  return registry.get(id)?.kind === 'light'
}
