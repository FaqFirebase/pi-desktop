import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { readSidebarSectionOpen, saveSidebarSectionOpen, type SidebarSection } from './sidebar-sections'

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
  else Reflect.deleteProperty(globalThis, 'localStorage')
})

test('sidebar sections default to expanded and independently restore both toggle states', () => {
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
    },
  })

  const sections: SidebarSection[] = ['tools', 'workspace', 'activity']
  for (const section of sections) {
    assert.equal(readSidebarSectionOpen(section), true)
    saveSidebarSectionOpen(section, false)
    for (const other of sections) {
      assert.equal(readSidebarSectionOpen(other), other !== section)
    }
    saveSidebarSectionOpen(section, true)
    assert.equal(readSidebarSectionOpen(section), true)
  }
})

test('unavailable storage does not break the sidebar', () => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => { throw new Error('Storage unavailable') },
      setItem: () => { throw new Error('Storage unavailable') },
    },
  })

  for (const section of ['tools', 'workspace', 'activity'] as const) {
    assert.equal(readSidebarSectionOpen(section), true)
    assert.doesNotThrow(() => saveSidebarSectionOpen(section, false))
  }
})
