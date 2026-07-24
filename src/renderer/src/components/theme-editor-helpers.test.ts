// src/renderer/src/components/theme-editor-helpers.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { forkTheme, withSeed, withOverride } from './theme-editor-helpers'
import { THEME_SCHEMA_V1, type ThemeFile } from '../../../shared/theme/theme-file'

const base: ThemeFile = {
  $schema: THEME_SCHEMA_V1, name: 'Nord', kind: 'dark',
  seeds: {
    app: '#2E3440', surface: '#3B4252', text: '#ECEFF4', accent: '#5E81AC',
    success: '#A3BE8C', warning: '#EBCB8B', error: '#BF616A',
  },
  overrides: { muted: '#9599A3' },
}

test('forkTheme deep-copies and renames', () => {
  const fork = forkTheme(base, 'Nord Fork')
  assert.equal(fork.name, 'Nord Fork')
  assert.notEqual(fork.seeds, base.seeds)
  assert.equal(fork.seeds.app, '#2E3440')
})

test('withSeed replaces one seed immutably', () => {
  const next = withSeed(base, 'app', '#000000')
  assert.equal(next.seeds.app, '#000000')
  assert.equal(base.seeds.app, '#2E3440')
})

test('withOverride pins and clears', () => {
  const pinned = withOverride(base, 'card', '#123456')
  assert.equal(pinned.overrides?.card, '#123456')
  const cleared = withOverride(pinned, 'muted', null)
  assert.equal(cleared.overrides?.muted, undefined)
  assert.equal(cleared.overrides?.card, '#123456')
})
