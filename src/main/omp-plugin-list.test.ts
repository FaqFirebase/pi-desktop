import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseOmpPluginList } from './omp-plugin-list'

const PLUGINS_DIR = '/home/u/.omp/plugins'

test('parseOmpPluginList handles the empty store', () => {
  assert.deepEqual(parseOmpPluginList('{"npm":[],"marketplace":[]}', PLUGINS_DIR), [])
})

test('parseOmpPluginList maps npm rows with their real install path', () => {
  const output = JSON.stringify({
    npm: [
      {
        name: '@oh-my-pi/example',
        version: '1.2.3',
        path: '/home/u/.omp/plugins/node_modules/@oh-my-pi/example',
        manifest: {},
        enabledFeatures: [],
        enabled: true,
      },
    ],
    marketplace: [],
  })
  assert.deepEqual(parseOmpPluginList(output, PLUGINS_DIR), [
    {
      name: '@oh-my-pi/example',
      source: '@oh-my-pi/example',
      type: 'package',
      version: '1.2.3',
      path: '/home/u/.omp/plugins/node_modules/@oh-my-pi/example',
    },
  ])
})

test('parseOmpPluginList maps marketplace rows by id (they carry no name)', () => {
  const output = JSON.stringify({
    npm: [],
    marketplace: [{ id: 'reviewer@main-market', scope: 'user', entries: [] }],
  })
  assert.deepEqual(parseOmpPluginList(output, PLUGINS_DIR), [
    {
      name: 'reviewer@main-market',
      source: 'reviewer@main-market',
      type: 'package',
      version: null,
      path: PLUGINS_DIR,
    },
  ])
})

test('parseOmpPluginList skips entries without a usable name or id', () => {
  const output = JSON.stringify({ npm: [{ version: '1.0.0' }, null, 42, 'bare-string', { name: '' }] })
  assert.deepEqual(parseOmpPluginList(output, PLUGINS_DIR), [])
})

test('parseOmpPluginList recovers JSON behind CLI warnings', () => {
  const output = `warning: something\n{"npm":[{"name":"x"}]}\n`
  assert.deepEqual(parseOmpPluginList(output, PLUGINS_DIR), [
    { name: 'x', source: 'x', type: 'package', version: null, path: PLUGINS_DIR },
  ])
})

test('parseOmpPluginList returns [] on garbage', () => {
  assert.deepEqual(parseOmpPluginList('not json at all', PLUGINS_DIR), [])
  assert.deepEqual(parseOmpPluginList('[]', PLUGINS_DIR), [])
  assert.deepEqual(parseOmpPluginList('', PLUGINS_DIR), [])
})
