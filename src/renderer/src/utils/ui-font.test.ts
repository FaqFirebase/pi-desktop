import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyUiFont, uiFontStack } from './ui-font'

test('font names are one quoted family with emoji and system fallbacks', () => {
  assert.equal(uiFontStack('  Helvetica Neue  '), '"Helvetica Neue", \'OpenMoji Color\', system-ui, sans-serif')
  assert.equal(uiFontStack('A,B'), '"A,B", \'OpenMoji Color\', system-ui, sans-serif')
  assert.equal(uiFontStack('A"B\\C\nD'), '"A\\22 B\\5c C\\a D", \'OpenMoji Color\', system-ui, sans-serif')
  assert.equal(uiFontStack('   '), '')
})

test('preview replaces the UI font and clearing restores CSS defaults', (t) => {
  const properties = new Map<string, string>()
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { documentElement: { style: {
      setProperty: (key: string, value: string) => properties.set(key, value),
      removeProperty: (key: string) => properties.delete(key),
    } } },
  })
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'document', original)
    else Reflect.deleteProperty(globalThis, 'document')
  })
  applyUiFont('Arial')
  assert.equal(properties.get('--ui-font-family'), uiFontStack('Arial'))
  applyUiFont('Georgia')
  assert.equal(properties.get('--ui-font-family'), uiFontStack('Georgia'))
  applyUiFont('')
  assert.equal(properties.size, 0)
})
