import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatDurationShort } from './format-duration'
import { i18n } from '../../../shared/i18n'
import { SOURCE_LANGUAGE } from '../../../shared/i18n/languages'

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

test('shows the largest unit and the next one', () => {
  assert.equal(formatDurationShort(4 * DAY + 10 * HOUR + 26 * MINUTE), '4d 10h')
  assert.equal(formatDurationShort(26 * MINUTE + 21 * SECOND), '26m 21s')
  assert.equal(formatDurationShort(2 * HOUR + 5 * MINUTE + 59 * SECOND), '2h 5m')
})

test('drops a zero second unit instead of showing it', () => {
  assert.equal(formatDurationShort(HOUR), '1h')
  assert.equal(formatDurationShort(3 * DAY + 20 * MINUTE), '3d')
})

test('rounds sub-second remainders down', () => {
  assert.equal(formatDurationShort(59 * SECOND + 999), '59s')
})

test('a past or zero duration reads as zero seconds', () => {
  assert.equal(formatDurationShort(0), '0s')
  assert.equal(formatDurationShort(500), '0s')
  assert.equal(formatDurationShort(-5 * MINUTE), '0s')
})

test('uses the interface language', async () => {
  await i18n.changeLanguage('ru')
  try {
    assert.equal(formatDurationShort(26 * MINUTE + 21 * SECOND), '26 мин 21 с')
  } finally {
    await i18n.changeLanguage(SOURCE_LANGUAGE)
  }
})
