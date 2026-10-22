import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectRelayUrl, readConfiguredRelayUrl, relayConfigPath } from './relay-url-detection'

async function configWith(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'relay-detect-'))
  const path = join(dir, 'config.json')
  await writeFile(path, body, 'utf8')
  return path
}

test('a relay in remote-pi config is offered', async () => {
  const path = await configWith(JSON.stringify({ relay: 'http://192.168.1.223:3000' }))
  assert.deepEqual(await detectRelayUrl({ configPath: path, env: {} }), {
    url: 'http://192.168.1.223:3000',
    source: 'config',
  })
})

test('the REMOTE_PI_RELAY override wins over the config file', async () => {
  const path = await configWith(JSON.stringify({ relay: 'http://from-config:3000' }))
  const detected = await detectRelayUrl({
    configPath: path,
    env: { REMOTE_PI_RELAY: 'https://from-env.example' },
  })
  assert.deepEqual(detected, { url: 'https://from-env.example', source: 'env' })
})

test('a missing config offers nothing rather than the community default', async () => {
  const detected = await detectRelayUrl({ configPath: join(tmpdir(), 'nope', 'config.json'), env: {} })
  assert.equal(detected, null)
})

test('invalid JSON offers nothing instead of throwing', async () => {
  const path = await configWith('{ not json')
  assert.equal(await readConfiguredRelayUrl(path), null)
})

test('a ws:// relay in config is rejected, since the desktop needs http(s)', async () => {
  const path = await configWith(JSON.stringify({ relay: 'ws://192.168.1.223:3000' }))
  assert.equal(await readConfiguredRelayUrl(path), null)
  assert.equal(await detectRelayUrl({ configPath: path, env: {} }), null)
})

test('a non-string relay field is ignored', async () => {
  const path = await configWith(JSON.stringify({ relay: 42 }))
  assert.equal(await readConfiguredRelayUrl(path), null)
})

test('the config path is ~/.pi/remote, not relative to the agent dir', () => {
  // With the default PI_CODING_AGENT_DIR of ~/.pi/agent, joining '..' would
  // resolve to ~/remote and find nothing.
  const path = relayConfigPath({ HOME: join('/home', 'x'), PI_CODING_AGENT_DIR: join('/home', 'x', '.pi', 'agent') })
  assert.equal(path, join('/home', 'x', '.pi', 'remote', 'config.json'))
})
