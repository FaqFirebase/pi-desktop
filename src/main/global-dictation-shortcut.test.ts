import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GlobalDictationShortcut, type ShortcutRegistry } from './global-dictation-shortcut'

function fakeRegistry(taken: string[] = []): ShortcutRegistry & { bound: Map<string, () => void> } {
  const bound = new Map<string, () => void>()
  return {
    bound,
    register(accelerator, callback) {
      if (taken.includes(accelerator) || bound.has(accelerator)) return false
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

test('independent Quick Chat and dictation bindings retain their own keys and callbacks', () => {
  const registry = fakeRegistry()
  let dictationPresses = 0
  let quickChatPresses = 0
  const dictation = new GlobalDictationShortcut(registry, () => dictationPresses++, () => assert.fail('dictation binding failed'))
  const quickChat = new GlobalDictationShortcut(registry, () => quickChatPresses++, () => {})
  dictation.apply('Mod+Alt+D')
  quickChat.apply('Mod+Alt+Q')
  registry.bound.get('CommandOrControl+Alt+D')!()
  registry.bound.get('CommandOrControl+Alt+Q')!()
  assert.equal(dictationPresses, 1)
  assert.equal(quickChatPresses, 1)
  assert.deepEqual(quickChat.getStatus(), { binding: 'Mod+Alt+Q', registered: true })

  // A failed change releases only Quick Chat's previous key, never the key
  // dictation already owns (even if a malformed settings file duplicates it).
  quickChat.apply('Mod+Alt+D')
  assert.deepEqual([...registry.bound.keys()], ['CommandOrControl+Alt+D'])
  assert.deepEqual(quickChat.getStatus(), { binding: 'Mod+Alt+D', registered: false })
  assert.deepEqual(dictation.getStatus(), { binding: 'Mod+Alt+D', registered: true })
  quickChat.apply(null)
  assert.deepEqual(quickChat.getStatus(), { binding: null, registered: false })
  registry.bound.get('CommandOrControl+Alt+D')!()
  assert.equal(dictationPresses, 2)
})

test('a key swap between two actions registers both once every old key is released first', () => {
  const registry = fakeRegistry()
  const dictation = new GlobalDictationShortcut(registry, () => {}, () => assert.fail('dictation binding failed'))
  const quickChat = new GlobalDictationShortcut(registry, () => {}, () => assert.fail('quick chat binding failed'))
  dictation.apply('Mod+Alt+D')
  quickChat.apply('Mod+Alt+Q')
  assert.deepEqual([...registry.bound.keys()], ['CommandOrControl+Alt+D', 'CommandOrControl+Alt+Q'])
  // The settings save path: each action frees the key the OTHER now wants
  // before either registers (dictation's new Q is held by quickChat, quick
  // chat's new D is held by dictation), so a swap never collides with a
  // still-held key. Releasing a key neither instance holds is a no-op.
  quickChat.releaseKey('CommandOrControl+Alt+X')
  quickChat.releaseKey('CommandOrControl+Alt+Q')
  dictation.releaseKey('CommandOrControl+Alt+D')
  dictation.apply('Mod+Alt+Q')
  quickChat.apply('Mod+Alt+D')
  assert.deepEqual([...registry.bound.keys()], ['CommandOrControl+Alt+Q', 'CommandOrControl+Alt+D'])
  assert.deepEqual(dictation.getStatus(), { binding: 'Mod+Alt+Q', registered: true })
  assert.deepEqual(quickChat.getStatus(), { binding: 'Mod+Alt+D', registered: true })
  registry.bound.get('CommandOrControl+Alt+Q')!()
  registry.bound.get('CommandOrControl+Alt+D')!()
})

test('repeated failures remain inactive, and retrying a released key can register', () => {
  const registry = fakeRegistry()
  const failures: string[] = []
  registry.bound.set('CommandOrControl+Alt+Q', () => {})
  const quickChat = new GlobalDictationShortcut(registry, () => {}, (key) => failures.push(key))
  for (let attempt = 0; attempt < 2; attempt++) {
    quickChat.apply('Mod+Alt+Q')
    assert.deepEqual(quickChat.getStatus(), { binding: 'Mod+Alt+Q', registered: false })
  }
  assert.deepEqual(failures, ['CommandOrControl+Alt+Q', 'CommandOrControl+Alt+Q'])
  registry.bound.delete('CommandOrControl+Alt+Q')
  quickChat.apply('Mod+Alt+Q')
  assert.deepEqual(quickChat.getStatus(), { binding: 'Mod+Alt+Q', registered: true })
  quickChat.apply(null)
  assert.equal(registry.bound.size, 0)
})

test('an unavailable registration service reports failure without claiming the saved key is active', () => {
  const registry = fakeRegistry()
  const failures: string[] = []
  const quickChat = new GlobalDictationShortcut(registry, () => {}, (key) => failures.push(key))
  quickChat.apply('Mod+Alt+Q')
  registry.register = () => { throw new Error('global shortcut service unavailable') }
  quickChat.apply('Mod+Alt+E')
  assert.equal(registry.bound.size, 0)
  assert.deepEqual(quickChat.getStatus(), { binding: 'Mod+Alt+E', registered: false })
  assert.deepEqual(failures, ['CommandOrControl+Alt+E'])
  quickChat.apply(null)
  assert.deepEqual(quickChat.getStatus(), { binding: null, registered: false })
})
