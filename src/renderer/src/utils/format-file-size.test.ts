import { test } from 'node:test'
import assert from 'node:assert/strict'
import { i18n } from '../../../shared/i18n'
import { SOURCE_LANGUAGE } from '../../../shared/i18n/languages'
import { formatFileSize } from './format-file-size'

function expected(value: number, unit: string): string {
  return new Intl.NumberFormat(SOURCE_LANGUAGE, { style: 'unit', unit, unitDisplay: 'narrow', maximumFractionDigits: 1 }).format(value)
}

test('formatFileSize picks the unit', async () => {
  await i18n.changeLanguage(SOURCE_LANGUAGE)
  assert.equal(formatFileSize(512), expected(512, 'byte'))
  assert.equal(formatFileSize(1536), expected(1.5, 'kilobyte'))
  assert.equal(formatFileSize(5 * 1024 * 1024), expected(5, 'megabyte'))
  assert.equal(formatFileSize(3 * 1024 * 1024 * 1024), expected(3, 'gigabyte'))
  assert.equal(formatFileSize(1024 ** 4), expected(1024, 'gigabyte'))
  assert.equal(formatFileSize(0), expected(0, 'byte'))
})
