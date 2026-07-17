import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateThemeFile } from '../../../shared/theme/theme-file'
import { resolveThemeVars } from '../../../shared/theme/resolve'
import { TOKEN_NAMES, cssVarForToken } from '../../../shared/theme/tokens'
import { BUILTIN_THEME_IDS } from './index'
import { BUILTIN_THEME_IDS as SHARED_BUILTIN_THEME_IDS } from '../../../shared/theme/builtin-ids'

const themesDir = dirname(fileURLToPath(import.meta.url))
const EXPECTED_IDS = [
  'dark', 'light', 'nord', 'gruvbox', 'breeze-dark', 'breeze-light', 'breeze-claudius',
]

test('renderer and shared built-in theme id lists never diverge', () => {
  assert.deepEqual(
    new Set(BUILTIN_THEME_IDS),
    new Set(SHARED_BUILTIN_THEME_IDS),
  )
})

test('all 7 built-in themes exist, validate, and fully resolve', () => {
  const files = readdirSync(themesDir).filter((f) => f.endsWith('.json')).sort()
  assert.deepEqual(files, [...EXPECTED_IDS].sort().map((id) => `${id}.json`))
  for (const file of files) {
    const theme = validateThemeFile(JSON.parse(readFileSync(join(themesDir, file), 'utf8')))
    const vars = resolveThemeVars(theme)
    for (const token of TOKEN_NAMES) {
      assert.ok(vars[cssVarForToken(token)], `${file}: unresolved ${token}`)
    }
  }
})

test('ported themes pin every token in overrides (parity guarantee)', () => {
  for (const id of EXPECTED_IDS) {
    if (id === 'dark' || id === 'light') continue
    const theme = validateThemeFile(
      JSON.parse(readFileSync(join(themesDir, `${id}.json`), 'utf8')),
    )
    const seedBacked = new Set(['app', 'surface', 'primary', 'accent', 'success', 'warning', 'error'])
    // error-hover and border-strong-hover have no legacy CSS counterpart to
    // reproduce (no theme ever remapped the red-500/600 or neutral-600 shades),
    // so they derive via MIX(..., 15) / MIX(..., 35) instead of pinning the
    // raw value that would carry the theme-blind bug forward.
    const derivedOnly = new Set(['error-hover', 'border-strong-hover'])
    for (const token of TOKEN_NAMES) {
      if (seedBacked.has(token) || derivedOnly.has(token)) continue
      assert.ok(theme.overrides?.[token], `${id}: token ${token} not pinned`)
    }
  }
})
