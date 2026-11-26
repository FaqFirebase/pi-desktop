import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fillTemplate, loadPermissionPromptText } from './permission-prompt-text'
import { makeTempDir } from '../src/shared/temp-dir.test-helper'

function localesWith(files: Record<string, unknown>): string {
  const dir = makeTempDir('pi-desktop-locales-')
  for (const [language, content] of Object.entries(files)) {
    mkdirSync(join(dir, language))
    writeFileSync(join(dir, language, 'translation.json'), JSON.stringify(content))
  }
  return dir
}

// A valid code with no language file (the pseudo-language has none).
const LANGUAGE_WITHOUT_FILE = 'en-XA'
const TEST_LANGUAGE = 'de'

const ENGLISH = {
  permissions: { prompt: { title: 'Allow {{tool}}?', body: '{{agent}} wants to run {{tool}}.', target: 'Target: {{path}}', command: 'Command: {{command}}' } },
}

const PLACEHOLDER_ONLY_TEXT = {
  title: '{{tool}}?',
  body: '{{agent}}: {{tool}}',
  target: '{{path}}',
  command: '{{command}}',
}

test('reads the chosen language', () => {
  const dir = localesWith({ en: ENGLISH, de: { permissions: { prompt: { title: '{{tool}} erlauben?', body: 'b', target: 't', command: 'c' } } } })
  assert.equal(loadPermissionPromptText(dir, 'de').title, '{{tool}} erlauben?')
})

test('falls back to English for each missing or empty value', () => {
  const dir = localesWith({ en: ENGLISH, de: { permissions: { prompt: { title: '', body: '{{agent}}: {{tool}}' } } } })
  const text = loadPermissionPromptText(dir, 'de')
  assert.equal(text.title, 'Allow {{tool}}?')
  assert.equal(text.body, '{{agent}}: {{tool}}')
  assert.equal(text.command, 'Command: {{command}}')
})

test('a missing language file uses English', () => {
  const dir = localesWith({ en: ENGLISH })
  assert.equal(loadPermissionPromptText(dir, LANGUAGE_WITHOUT_FILE).title, 'Allow {{tool}}?')
})

test('no language (older GUI) reads English', () => {
  const dir = localesWith({ en: ENGLISH })
  assert.equal(loadPermissionPromptText(dir, null).title, 'Allow {{tool}}?')
})

test('no locales folder uses placeholder-only templates', () => {
  assert.deepEqual(loadPermissionPromptText(null, 'en'), PLACEHOLDER_ONLY_TEXT)
})

test('a language code with path parts is not read', () => {
  const dir = localesWith({ en: ENGLISH })
  assert.equal(loadPermissionPromptText(dir, '../en').title, 'Allow {{tool}}?')
})

test('fillTemplate replaces known names and keeps $ patterns literal', () => {
  assert.equal(fillTemplate('Run {{tool}} on {{path}}', { tool: 'bash', path: '$&' }), 'Run bash on $&')
  assert.equal(fillTemplate('{{unknown}} stays', {}), '{{unknown}} stays')
})

// A translation that drops or mangles a required placeholder must not hide
// what the user is approving, so it is rejected in favor of the English text.
const COMMAND_WITHOUT_PLACEHOLDER = 'Befehl ausfuehren'
const COMMAND_WITH_SPACED_PLACEHOLDER = 'Befehl:\n{{ command }}'
const COMMAND_WITH_PLACEHOLDER = 'Befehl:\n{{command}}'

test('a translated command missing its placeholder falls back to English', () => {
  const dir = localesWith({ en: ENGLISH, [TEST_LANGUAGE]: { permissions: { prompt: { command: COMMAND_WITHOUT_PLACEHOLDER } } } })
  assert.equal(loadPermissionPromptText(dir, TEST_LANGUAGE).command, ENGLISH.permissions.prompt.command)
})

test('a translated command with a malformed placeholder falls back to English', () => {
  const dir = localesWith({ en: ENGLISH, [TEST_LANGUAGE]: { permissions: { prompt: { command: COMMAND_WITH_SPACED_PLACEHOLDER } } } })
  assert.equal(loadPermissionPromptText(dir, TEST_LANGUAGE).command, ENGLISH.permissions.prompt.command)
})

test('a translated command that keeps its placeholder is used', () => {
  const dir = localesWith({ en: ENGLISH, [TEST_LANGUAGE]: { permissions: { prompt: { command: COMMAND_WITH_PLACEHOLDER } } } })
  assert.equal(loadPermissionPromptText(dir, TEST_LANGUAGE).command, COMMAND_WITH_PLACEHOLDER)
})

const SHIPPED_LOCALES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'locales')
const SHIPPED_LANGUAGE = 'en'
const SAMPLE_TOOL = 'bash'
const SAMPLE_AGENT = 'Pi'
const SAMPLE_PATH = 'src/a.ts'
const SAMPLE_COMMAND = 'ls -la'

test('the shipped English prompt text matches today\'s wording', () => {
  const text = loadPermissionPromptText(SHIPPED_LOCALES_DIR, SHIPPED_LANGUAGE)
  assert.equal(fillTemplate(text.title, { tool: SAMPLE_TOOL }), 'Allow bash?')
  assert.equal(fillTemplate(text.body, { agent: SAMPLE_AGENT, tool: SAMPLE_TOOL }), 'Pi wants to run the bash tool.')
  assert.equal(fillTemplate(text.target, { path: SAMPLE_PATH }), 'Target: src/a.ts')
  assert.equal(fillTemplate(text.command, { command: SAMPLE_COMMAND }), 'Command:\nls -la')
})

test('a corrupt English file uses placeholder-only templates', () => {
  const dir = makeTempDir('pi-desktop-locales-')
  mkdirSync(join(dir, SHIPPED_LANGUAGE))
  writeFileSync(join(dir, SHIPPED_LANGUAGE, 'translation.json'), '{not json')
  assert.deepEqual(loadPermissionPromptText(dir, TEST_LANGUAGE), PLACEHOLDER_ONLY_TEXT)
})
