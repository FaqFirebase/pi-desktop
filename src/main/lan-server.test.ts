import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildLanUrls,
  generateLanToken,
  listLanAddresses,
  DEFAULT_LAN_PORT,
} from './lan-server'

test('generateLanToken returns a non-empty url-safe string', () => {
  const a = generateLanToken()
  const b = generateLanToken()
  assert.ok(a.length >= 16)
  assert.notEqual(a, b)
  assert.match(a, /^[A-Za-z0-9_-]+$/)
})

test('buildLanUrls uses DEFAULT_LAN_PORT and http scheme', () => {
  const urls = buildLanUrls(DEFAULT_LAN_PORT)
  assert.ok(urls.length >= 1)
  for (const u of urls) {
    assert.ok(u.startsWith('http://'))
    assert.ok(u.endsWith(`:${DEFAULT_LAN_PORT}`))
  }
})

test('listLanAddresses returns only IPv4-looking strings', () => {
  for (const addr of listLanAddresses()) {
    assert.match(addr, /^\d{1,3}(\.\d{1,3}){3}$/)
  }
})
