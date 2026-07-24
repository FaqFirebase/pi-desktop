import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveThemeVars } from './resolve'
import { TOKEN_NAMES, cssVarForToken } from './tokens'
import { SYNTAX_KEYS, THEME_SCHEMA_V1, type ThemeFile } from './theme-file'

const base: ThemeFile = {
  $schema: THEME_SCHEMA_V1,
  name: 'Test',
  kind: 'dark',
  seeds: {
    app: '#0a0a0a', surface: '#171717', text: '#f5f5f5', accent: '#2563eb',
    success: '#34d399', warning: '#facc15', error: '#f87171',
  },
}

test('resolves every token and syntax variable', () => {
  const vars = resolveThemeVars(base)
  for (const token of TOKEN_NAMES) {
    assert.ok(vars[cssVarForToken(token)], `missing ${token}`)
  }
  for (const key of SYNTAX_KEYS) {
    assert.ok(vars[`--cm-${key}`], `missing --cm-${key}`)
  }
})

test('seeds pass through, derived tokens are color-mix templates', () => {
  const vars = resolveThemeVars(base)
  assert.equal(vars['--color-app'], '#0a0a0a')
  assert.equal(vars['--color-primary'], '#f5f5f5')
  assert.match(vars['--color-surface-hover'], /^color-mix\(in oklab,/)
})

test('overrides beat seeds and derivations', () => {
  const vars = resolveThemeVars({
    ...base,
    overrides: { surface: '#123456', 'surface-hover': '#654321' },
  })
  assert.equal(vars['--color-surface'], '#123456')
  assert.equal(vars['--color-surface-hover'], '#654321')
})

test('overriding a non-identity-mapped token beats its backing seed', () => {
  // 'surface' above is identity-named with its seed (seed 'surface' backs
  // token 'surface'), which would still pass if override precedence only
  // ever checked the seed name rather than the token name. 'primary' is
  // backed by the differently-named seed 'text' (see SEED_TO_TOKEN), so this
  // catches a regression that special-cases identity-named seeds.
  const vars = resolveThemeVars({
    ...base,
    overrides: { primary: '#abcdef' },
  })
  assert.equal(vars['--color-primary'], '#abcdef')
})

test('syntax merges over kind defaults', () => {
  const vars = resolveThemeVars({ ...base, syntax: { keyword: '#ff0000' } })
  assert.equal(vars['--cm-keyword'], '#ff0000')
  assert.ok(vars['--cm-string'].startsWith('#'))
})

test('light kind selects the light syntax defaults', () => {
  const dark = resolveThemeVars(base)
  const light = resolveThemeVars({ ...base, kind: 'light' })
  assert.notEqual(dark['--cm-keyword'], light['--cm-keyword'])
})
