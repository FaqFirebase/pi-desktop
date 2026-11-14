import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatDecimal, formatPercent } from './format-number'
import { i18n } from '../../../shared/i18n'
import { SOURCE_LANGUAGE } from '../../../shared/i18n/languages'

const NO_BREAK_SPACE = ' '

async function inLanguage(language: string, check: () => void): Promise<void> {
  await i18n.changeLanguage(language)
  try {
    check()
  } finally {
    await i18n.changeLanguage(SOURCE_LANGUAGE)
  }
}

test('formatDecimal always shows the asked number of decimals', () => {
  assert.equal(formatDecimal(0.13, 2), '0.13')
  assert.equal(formatDecimal(1, 2), '1.00')
  assert.equal(formatDecimal(0.126, 2), '0.13')
})

test('formatPercent turns a fraction into a percentage with fixed decimals', () => {
  assert.equal(formatPercent(0.13, 1), '13.0%')
  assert.equal(formatPercent(0, 1), '0.0%')
  assert.equal(formatPercent(1.25, 1), '125.0%')
})

test('numbers use the decimal mark and percent layout of the interface language', async () => {
  await inLanguage('ru', () => {
    assert.equal(formatDecimal(0.13, 2), '0,13')
    assert.equal(formatPercent(0.13, 1), `13,0${NO_BREAK_SPACE}%`)
  })
  await inLanguage('tr', () => {
    assert.equal(formatDecimal(0.13, 2), '0,13')
    assert.equal(formatPercent(0.13, 1), '%13,0')
  })
})
