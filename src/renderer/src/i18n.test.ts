import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bootLanguageFrom, languagePickerOptions, loadedI18nEnvironment, loadI18nEnvironment } from './i18n'
import { PSEUDO_LANGUAGE, SOURCE_LANGUAGE, SYSTEM_LANGUAGE } from '../../shared/i18n/languages'
import { BUNDLED_LANGUAGES } from '../../shared/i18n/resources'
import { i18n } from '../../shared/i18n'

const SIMPLIFIED_CHINESE = 'zh-Hans'
const ENVIRONMENT_LOAD_FAILURE = new Error('environment load failed')
const RETRIED_ENVIRONMENT = { systemLanguages: [], pseudoLanguageEnabled: false }

test('bootLanguageFrom accepts a stored available code', () => {
  assert.equal(bootLanguageFrom(SOURCE_LANGUAGE), SOURCE_LANGUAGE)
  assert.equal(bootLanguageFrom(PSEUDO_LANGUAGE), PSEUDO_LANGUAGE)
})

test('bootLanguageFrom falls back to English for missing or unknown values', () => {
  assert.equal(bootLanguageFrom(null), SOURCE_LANGUAGE)
  assert.equal(bootLanguageFrom('xx-unknown'), SOURCE_LANGUAGE)
})

test('the picker starts with System default and names the resolved system language', () => {
  const options = languagePickerOptions({ systemLanguages: ['fr-FR'], pseudoLanguageEnabled: false })
  assert.deepEqual(options[0], { value: SYSTEM_LANGUAGE, label: 'System default (English)' })
  // Found by value: the picker sorts by label, so positions shift as languages are added.
  assert.deepEqual(options.find((o) => o.value === SOURCE_LANGUAGE), { value: SOURCE_LANGUAGE, label: 'English' })
  // Every bundled language is offered under its own native name (English would mean a missing fallback).
  for (const code of BUNDLED_LANGUAGES) {
    const option = options.find((o) => o.value === code)
    assert.ok(option, code)
    if (code !== SOURCE_LANGUAGE) assert.notEqual(option.label, 'English', code)
  }
})

test('each language also shows its name in the interface language when the two differ', async () => {
  const environment = { systemLanguages: [], pseudoLanguageEnabled: false }
  const labelOf = (code: string) => languagePickerOptions(environment).find((o) => o.value === code)?.label
  assert.equal(labelOf(SOURCE_LANGUAGE), 'English')
  assert.equal(labelOf(SIMPLIFIED_CHINESE), '简体中文 (Simplified Chinese)')
  await i18n.changeLanguage(SIMPLIFIED_CHINESE)
  try {
    assert.equal(labelOf(SOURCE_LANGUAGE), 'English（英语）')
    assert.equal(labelOf(SIMPLIFIED_CHINESE), '简体中文')
  } finally {
    await i18n.changeLanguage(SOURCE_LANGUAGE)
  }
})

test('the picker offers the pseudo-language only when enabled', () => {
  const values = languagePickerOptions({ systemLanguages: [], pseudoLanguageEnabled: true }).map((o) => o.value)
  assert.ok(values.includes(PSEUDO_LANGUAGE))
  const plain = languagePickerOptions({ systemLanguages: [], pseudoLanguageEnabled: false }).map((o) => o.value)
  assert.ok(!plain.includes(PSEUDO_LANGUAGE))
})

test('loadI18nEnvironment retries after a failed request instead of caching the rejection', async () => {
  let callCount = 0
  const originalWindow = (globalThis as { window?: unknown }).window
  ;(globalThis as { window: unknown }).window = {
    piDesktop: {
      i18n: {
        getEnvironment: () => {
          callCount += 1
          return callCount === 1 ? Promise.reject(ENVIRONMENT_LOAD_FAILURE) : Promise.resolve(RETRIED_ENVIRONMENT)
        },
      },
    },
  }
  try {
    await assert.rejects(loadI18nEnvironment(), ENVIRONMENT_LOAD_FAILURE)
    assert.deepEqual(await loadI18nEnvironment(), RETRIED_ENVIRONMENT)
    assert.deepEqual(loadedI18nEnvironment(), RETRIED_ENVIRONMENT)
  } finally {
    ;(globalThis as { window?: unknown }).window = originalWindow
  }
})
