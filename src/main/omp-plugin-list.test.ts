import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseOmpPluginList } from './omp-plugin-list'

const PLUGINS_DIR = '/home/u/.omp/plugins'

test('parseOmpPluginList handles the empty store', () => {
  assert.deepEqual(parseOmpPluginList('{"npm":[],"marketplace":[]}', PLUGINS_DIR), [])
})

test('parseOmpPluginList maps object entries', () => {
  const output = JSON.stringify({
    npm: [{ name: '@oh-my-pi/example', version: '1.2.3', source: 'npm:@oh-my-pi/example' }],
    marketplace: [{ name: 'reviewer', spec: 'reviewer@main-market' }],
  })
  assert.deepEqual(parseOmpPluginList(output, PLUGINS_DIR), [
    {
      name: '@oh-my-pi/example',
      source: 'npm:@oh-my-pi/example',
      type: 'npm',
      version: '1.2.3',
      path: PLUGINS_DIR,
    },
    {
      name: 'reviewer',
      source: 'reviewer@main-market',
      type: 'marketplace',
      version: null,
      path: PLUGINS_DIR,
    },
  ])
})

test('parseOmpPluginList tolerates bare string entries', () => {
  const output = JSON.stringify({ npm: ['left-pad'] })
  assert.deepEqual(parseOmpPluginList(output, PLUGINS_DIR), [
    { name: 'left-pad', source: 'left-pad', type: 'npm', version: null, path: PLUGINS_DIR },
  ])
})

test('parseOmpPluginList skips entries without a usable name', () => {
  const output = JSON.stringify({ npm: [{ version: '1.0.0' }, null, 42, ''] })
  assert.deepEqual(parseOmpPluginList(output, PLUGINS_DIR), [])
})

test('parseOmpPluginList recovers JSON behind CLI warnings', () => {
  const output = `warning: something\n{"npm":[{"name":"x"}]}\n`
  assert.deepEqual(parseOmpPluginList(output, PLUGINS_DIR), [
    { name: 'x', source: 'x', type: 'npm', version: null, path: PLUGINS_DIR },
  ])
})

test('parseOmpPluginList returns [] on garbage', () => {
  assert.deepEqual(parseOmpPluginList('not json at all', PLUGINS_DIR), [])
  assert.deepEqual(parseOmpPluginList('[]', PLUGINS_DIR), [])
  assert.deepEqual(parseOmpPluginList('', PLUGINS_DIR), [])
})
