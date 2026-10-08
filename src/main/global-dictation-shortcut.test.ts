import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GlobalDictationShortcut, type ShortcutRegistry } from './global-dictation-shortcut'

function fakeRegistry(taken: string[] = []): ShortcutRegistry & { bound: Map<string, () => void> } {
  const bound = new Map<string, () => void>()
  return {
    bound,
    register(accelerator, callback) {
      if (taken.includes(accelerator)) return false
      bound.set(accelerator, callback)
      return true
    },
    unregister(accelerator) {
      bound.delete(accelerator)
    },
  }
}

test('the system-wide key presses toggle dictation and rebind on change', () => {
  const registry = fakeRegistry()
  let presses = 0
  const shortcut = new GlobalDictationShortcut(registry, () => presses++, () => assert.fail('no failure expected'))
  shortcut.apply('Mod+Alt+D')
  assert.deepEqual([...registry.bound.keys()], ['CommandOrControl+Alt+D'])
  registry.bound.get('CommandOrControl+Alt+D')!()
  assert.equal(presses, 1)
  shortcut.apply('Mod+Alt+D')
  assert.deepEqual([...registry.bound.keys()], ['CommandOrControl+Alt+D'])
  shortcut.apply('Ctrl+Shift+F5')
  assert.deepEqual([...registry.bound.keys()], ['Control+Shift+F5'])
  shortcut.apply(null)
  assert.equal(registry.bound.size, 0)
})

test('a key another app holds is reported and not kept, so a later change binds again', () => {
  const registry = fakeRegistry(['CommandOrControl+Alt+D'])
  const failures: string[] = []
  const shortcut = new GlobalDictationShortcut(registry, () => {}, (accelerator) => failures.push(accelerator))
  shortcut.apply('Mod+Alt+D')
  assert.deepEqual(failures, ['CommandOrControl+Alt+D'])
  assert.equal(registry.bound.size, 0)
  shortcut.apply('Mod+Alt+E')
  assert.deepEqual([...registry.bound.keys()], ['CommandOrControl+Alt+E'])
})
