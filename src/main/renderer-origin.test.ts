import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isTrustedRendererUrl } from './renderer-origin'

const INDEX = '/opt/app/resources/renderer/index.html'

test('dev: accepts the dev server origin (any path/hash)', () => {
  const opts = { devServerUrl: 'http://localhost:5173', rendererIndexPath: INDEX }
  assert.equal(isTrustedRendererUrl('http://localhost:5173/', opts), true)
  assert.equal(isTrustedRendererUrl('http://localhost:5173/#/chat', opts), true)
})

test('dev: rejects a look-alike host that only shares a prefix', () => {
  const opts = { devServerUrl: 'http://localhost:5173', rendererIndexPath: INDEX }
  assert.equal(isTrustedRendererUrl('http://localhost:5173.evil.com/', opts), false)
  assert.equal(isTrustedRendererUrl('http://evil.com/localhost:5173', opts), false)
})

test('prod: accepts the packaged index file, ignoring hash routing', () => {
  const opts = { rendererIndexPath: INDEX }
  assert.equal(isTrustedRendererUrl('file:///opt/app/resources/renderer/index.html', opts), true)
  assert.equal(isTrustedRendererUrl('file:///opt/app/resources/renderer/index.html#/settings', opts), true)
})

test('prod: rejects any other local file', () => {
  const opts = { rendererIndexPath: INDEX }
  assert.equal(isTrustedRendererUrl('file:///opt/app/resources/renderer/evil.html', opts), false)
  assert.equal(isTrustedRendererUrl('file:///etc/passwd', opts), false)
})

test('rejects unparseable input', () => {
  assert.equal(isTrustedRendererUrl('not a url', { rendererIndexPath: INDEX }), false)
})
