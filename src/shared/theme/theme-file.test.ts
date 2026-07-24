// src/shared/theme/theme-file.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateThemeFile, ThemeValidationError, themeIdFromName, THEME_SCHEMA_V1,
} from './theme-file'

const valid = {
  $schema: THEME_SCHEMA_V1,
  name: 'My Theme',
  kind: 'dark',
  seeds: {
    app: '#0a0a0a', surface: '#171717', text: '#f5f5f5', accent: '#2563eb',
    success: '#34d399', warning: '#facc15', error: '#f87171',
  },
}

test('accepts a minimal valid theme', () => {
  const theme = validateThemeFile(valid)
  assert.equal(theme.name, 'My Theme')
  assert.equal(theme.kind, 'dark')
})

test('accepts rgba and transparent in overrides and syntax', () => {
  const theme = validateThemeFile({
    ...valid,
    overrides: { 'accent-bg': 'rgba(30, 58, 138, 0.3)', 'chat-column-border': 'transparent' },
    syntax: { keyword: '#c678dd' },
  })
  assert.equal(theme.overrides?.['chat-column-border'], 'transparent')
})

test('accepts rgba with 1.0 alpha (full opacity written with trailing zero)', () => {
  const theme = validateThemeFile({
    ...valid,
    overrides: { 'accent-bg': 'rgba(0, 0, 0, 1.0)' },
  })
  assert.equal(theme.overrides?.['accent-bg'], 'rgba(0, 0, 0, 1.0)')
})

for (const [label, mutate] of [
  ['wrong $schema', (t: Record<string, unknown>) => { t.$schema = 'pi-theme/v9' }],
  ['missing seed', (t: Record<string, unknown>) => {
    const seeds = { ...valid.seeds } as Record<string, unknown>
    delete seeds.accent
    t.seeds = seeds
  }],
  ['undefined-valued seed', (t: Record<string, unknown>) => { t.seeds = { ...valid.seeds, accent: undefined } }],
  ['bad color value', (t: Record<string, unknown>) => { t.seeds = { ...valid.seeds, app: 'url(javascript:x)' } }],
  ['unknown override key', (t: Record<string, unknown>) => { t.overrides = { 'not-a-token': '#fff' } }],
  ['unknown syntax key', (t: Record<string, unknown>) => { t.syntax = { sparkle: '#fff' } }],
  ['bad kind', (t: Record<string, unknown>) => { t.kind = 'sepia' }],
  ['empty name', (t: Record<string, unknown>) => { t.name = '' }],
  ['oversized name', (t: Record<string, unknown>) => { t.name = 'x'.repeat(65) }],
  ['non-object', () => null],
] as const) {
  test(`rejects ${label}`, () => {
    const data: Record<string, unknown> | null =
      label === 'non-object' ? null : structuredClone(valid) as Record<string, unknown>
    if (data) (mutate as (t: Record<string, unknown>) => void)(data)
    assert.throws(() => validateThemeFile(data), ThemeValidationError)
  })
}

test('themeIdFromName slugifies', () => {
  assert.equal(themeIdFromName('My Nord Fork!'), 'my-nord-fork')
})

test('accepts optional author and description, trims them', () => {
  const theme = validateThemeFile({
    ...valid,
    author: '  Pi Desktop  ',
    description: 'A calm dark theme.',
  })
  assert.equal(theme.author, 'Pi Desktop')
  assert.equal(theme.description, 'A calm dark theme.')
  // Absent fields stay absent, not empty strings.
  const bare = validateThemeFile(valid)
  assert.equal('author' in bare, false)
  assert.equal('description' in bare, false)
})

test('rejects invalid author and description values', () => {
  assert.throws(() => validateThemeFile({ ...valid, author: '' }), ThemeValidationError)
  assert.throws(() => validateThemeFile({ ...valid, author: 42 }), ThemeValidationError)
  assert.throws(() => validateThemeFile({ ...valid, author: 'x'.repeat(65) }), ThemeValidationError)
  assert.throws(() => validateThemeFile({ ...valid, description: 'x'.repeat(281) }), ThemeValidationError)
})
