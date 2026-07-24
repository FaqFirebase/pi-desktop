import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyThemeVars } from './engine'

function fakeTarget() {
  const set = new Map<string, string>()
  return {
    set,
    style: {
      setProperty: (k: string, v: string) => { set.set(k, v) },
      removeProperty: (k: string) => { set.delete(k) },
    },
  }
}

test('applies all vars and returns applied keys', () => {
  const target = fakeTarget()
  const keys = applyThemeVars(target, { '--color-app': '#111', '--cm-keyword': '#f0f' }, [])
  assert.deepEqual([...keys].sort(), ['--cm-keyword', '--color-app'])
  assert.equal(target.set.get('--color-app'), '#111')
})

test('removes stale vars from the previous application', () => {
  const target = fakeTarget()
  const first = applyThemeVars(target, { '--color-app': '#111', '--color-extra': '#222' }, [])
  applyThemeVars(target, { '--color-app': '#333' }, first)
  assert.equal(target.set.get('--color-app'), '#333')
  assert.equal(target.set.has('--color-extra'), false)
})
