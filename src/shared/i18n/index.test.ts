import { test } from 'node:test'
import assert from 'node:assert/strict'
import { availableLanguages, i18n, languageNativeName, t } from './index'
import { PSEUDO_LANGUAGE, SOURCE_LANGUAGE } from './languages'
import { BUNDLED_LANGUAGES } from './resources'

const EMPTY_TEST_LANGUAGE = 'xx'
const NAMESPACE = 'translation'

test('the shared instance starts in English with the bundled resources', () => {
  assert.equal(i18n.isInitialized, true)
  assert.equal(i18n.language, SOURCE_LANGUAGE)
  assert.equal(t('language.nativeName'), 'English')
})

test('availableLanguages adds the pseudo-language only when enabled', () => {
  assert.deepEqual(availableLanguages(false), [...BUNDLED_LANGUAGES])
  assert.deepEqual(availableLanguages(true), [...BUNDLED_LANGUAGES, PSEUDO_LANGUAGE])
})

test('an empty translation falls back to English', () => {
  i18n.addResourceBundle(EMPTY_TEST_LANGUAGE, NAMESPACE, { language: { nativeName: '' } })
  try {
    assert.equal(languageNativeName(EMPTY_TEST_LANGUAGE), 'English')
  } finally {
    i18n.removeResourceBundle(EMPTY_TEST_LANGUAGE, NAMESPACE)
  }
})

test('the pseudo-language marks text but not explicit English lookups', async () => {
  await i18n.changeLanguage(PSEUDO_LANGUAGE)
  try {
    assert.equal(t('language.nativeName'), '[Éñĝļîšĥ ~~~]')
    assert.equal(t('language.nativeName', { lng: SOURCE_LANGUAGE }), 'English')
    assert.equal(languageNativeName(PSEUDO_LANGUAGE), '[Éñĝļîšĥ ~~~]')
  } finally {
    await i18n.changeLanguage(SOURCE_LANGUAGE)
  }
})

test('the pseudo-language bundle leaves interpolated values unmarked', async () => {
  await i18n.changeLanguage(PSEUDO_LANGUAGE)
  try {
    // The placeholder is substituted after lookup, so the pseudo-localized
    // sentence around it is marked but the inserted value is plain English.
    assert.match(t('settings.language.system', { language: 'English' }), /\(English\)/)
    // An explicit English lookup is never pseudo-localized.
    assert.equal(t('settings.language.label', { lng: SOURCE_LANGUAGE }), 'Language')
  } finally {
    await i18n.changeLanguage(SOURCE_LANGUAGE)
  }
})
