import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { DEFAULT_SETTINGS } from '../../../shared/default-settings'
import { BUILTIN_THEMES } from '../themes'
import {
  BOOT_THEME_STORAGE_KEY,
  applyThemeSettings,
  getAppliedThemeId,
  registerThemes,
  rememberBootTheme,
  resolveSystemThemeSlot,
  resolveThemeId,
  subscribeAppliedTheme,
} from './theme'

// theme.ts reads the OS preference through matchMedia, writes CSS vars to
// <html>, and remembers the boot theme in localStorage; node has none of
// these, so stub the minimum surface those calls touch.
let prefersDark = false
const storage = new Map<string, string>()
Object.assign(globalThis, {
  window: { matchMedia: () => ({ matches: prefersDark }) },
  document: {
    documentElement: {
      style: { setProperty() {}, removeProperty() {}, colorScheme: '' },
      classList: { toggle() {} },
    },
  },
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) },
  },
})

const BOOT_SCRIPT = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../public/theme-boot.js'), 'utf8')

interface BootResult {
  vars: Record<string, string>
  colorScheme: string
  lightClass: boolean
}

// Runs the pre-paint boot script the way index.html does, against the value
// rememberBootTheme left in storage and the given OS preference.
function runBootScript(osPrefersDark: boolean, stored = storage.get(BOOT_THEME_STORAGE_KEY) ?? null): BootResult {
  const result: BootResult = { vars: {}, colorScheme: '', lightClass: false }
  const style = {
    setProperty: (key: string, value: string) => { result.vars[key] = value },
    set colorScheme(value: string) { result.colorScheme = value },
  }
  runInNewContext(BOOT_SCRIPT, {
    window: { matchMedia: () => ({ matches: osPrefersDark }) },
    localStorage: { getItem: () => stored },
    document: {
      documentElement: {
        style,
        classList: { toggle: (name: string, on: boolean) => { if (name === 'light') result.lightClass = on } },
      },
    },
  })
  return result
}

const SYSTEM_WITH_GRUVBOX = { theme: 'system', systemLightTheme: 'breeze-light', systemDarkTheme: 'gruvbox' }

function builtinFile(id: string) {
  const theme = BUILTIN_THEMES.find((candidate) => candidate.id === id)
  assert.ok(theme, `missing built-in theme ${id}`)
  return theme.file
}

test('the default theme stays dark when the OS prefers light', () => {
  prefersDark = false
  assert.equal(resolveThemeId(DEFAULT_SETTINGS.theme), 'dark')
})

test('the default System themes are built-in themes of the matching kind', () => {
  assert.equal(builtinFile(DEFAULT_SETTINGS.systemLightTheme).kind, 'light')
  assert.equal(builtinFile(DEFAULT_SETTINGS.systemDarkTheme).kind, 'dark')
})

test('a concrete theme id resolves to itself', () => {
  assert.equal(resolveThemeId('nord'), 'nord')
})

test('System resolves to the chosen light theme when the OS prefers light', () => {
  prefersDark = false
  applyThemeSettings(SYSTEM_WITH_GRUVBOX)
  assert.equal(resolveThemeId('system'), 'breeze-light')
})

test('System resolves to the chosen dark theme when the OS prefers dark', () => {
  prefersDark = true
  applyThemeSettings(SYSTEM_WITH_GRUVBOX)
  assert.equal(resolveThemeId('system'), 'gruvbox')
})

test('a missing System theme falls back to the built-in default for its slot', () => {
  assert.equal(resolveSystemThemeSlot('dark', 'deleted-theme'), DEFAULT_SETTINGS.systemDarkTheme)
})

test('a System theme of the other kind falls back to the built-in default for its slot', () => {
  assert.equal(resolveSystemThemeSlot('light', 'gruvbox'), DEFAULT_SETTINGS.systemLightTheme)
})

test('a registered user theme of the matching kind fills a System slot', () => {
  registerThemes([{ id: 'my-dusk', file: { ...builtinFile('gruvbox'), name: 'My Dusk' } }])
  assert.equal(resolveSystemThemeSlot('dark', 'my-dusk'), 'my-dusk')
})

test('applying System notifies subscribers with the theme it resolved to', () => {
  prefersDark = true
  applyThemeSettings({ ...SYSTEM_WITH_GRUVBOX, theme: 'light' })
  const notified: string[] = []
  const unsubscribe = subscribeAppliedTheme(() => notified.push(getAppliedThemeId() ?? ''))
  applyThemeSettings(SYSTEM_WITH_GRUVBOX)
  unsubscribe()
  assert.deepEqual(notified, ['gruvbox'])
  assert.equal(getAppliedThemeId(), 'gruvbox')
})

test('re-applying the same theme still notifies subscribers', () => {
  applyThemeSettings({ ...SYSTEM_WITH_GRUVBOX, theme: 'nord' })
  let notified = 0
  const unsubscribe = subscribeAppliedTheme(() => { notified++ })
  applyThemeSettings({ ...SYSTEM_WITH_GRUVBOX, theme: 'nord' })
  unsubscribe()
  assert.equal(notified, 1)
})

test('the boot script paints the remembered System dark theme on a dark OS', () => {
  rememberBootTheme(SYSTEM_WITH_GRUVBOX)
  const boot = runBootScript(true)
  assert.equal(boot.vars['--color-app'], builtinFile('gruvbox').seeds.app)
  assert.equal(boot.vars['--color-primary'], builtinFile('gruvbox').seeds.text)
  assert.equal(boot.colorScheme, 'dark')
  assert.equal(boot.lightClass, false)
})

test('the boot script paints the remembered System light theme on a light OS', () => {
  rememberBootTheme(SYSTEM_WITH_GRUVBOX)
  const boot = runBootScript(false)
  assert.equal(boot.vars['--color-app'], builtinFile('breeze-light').seeds.app)
  assert.equal(boot.colorScheme, 'light')
  assert.equal(boot.lightClass, true)
})

test('the boot script paints a concrete theme the same on either OS', () => {
  rememberBootTheme({ ...SYSTEM_WITH_GRUVBOX, theme: 'nord' })
  assert.deepEqual(runBootScript(false), runBootScript(true))
  assert.equal(runBootScript(false).vars['--color-app'], builtinFile('nord').seeds.app)
})

test('a missing concrete theme is remembered as the fallback theme', () => {
  rememberBootTheme({ ...SYSTEM_WITH_GRUVBOX, theme: 'deleted-theme' })
  assert.equal(runBootScript(false).vars['--color-app'], builtinFile('dark').seeds.app)
})

// With nothing remembered (first launch), the body must not paint the dark
// stylesheet default; a transparent app color lets the OS-mode canvas show.
test('without a remembered theme the boot script shows the OS-mode canvas', () => {
  const boot = runBootScript(false, null)
  assert.deepEqual(boot.vars, { '--color-app': 'transparent' })
  assert.equal(boot.colorScheme, 'light')
})

test('the boot script ignores a corrupt remembered theme', () => {
  const boot = runBootScript(true, '{not json')
  assert.deepEqual(boot.vars, { '--color-app': 'transparent' })
  assert.equal(boot.colorScheme, 'dark')
})
