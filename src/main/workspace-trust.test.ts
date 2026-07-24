import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceTrustStore } from './workspace-trust'

function tmpFile(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'pi-trust-'))
  return { path: join(dir, 'trusted-workspaces.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('an unknown workspace is not trusted', () => {
  const { path, cleanup } = tmpFile()
  try {
    const store = new WorkspaceTrustStore(path)
    assert.equal(store.isTrusted('/home/alice/project'), false)
  } finally {
    cleanup()
  }
})

test('trust() marks a workspace trusted and persists across instances', async () => {
  const { path, cleanup } = tmpFile()
  try {
    const store = new WorkspaceTrustStore(path)
    await store.trust('/home/alice/project')
    assert.equal(store.isTrusted('/home/alice/project'), true)
    // A fresh instance reading the same file sees the persisted trust.
    assert.equal(new WorkspaceTrustStore(path).isTrusted('/home/alice/project'), true)
  } finally {
    cleanup()
  }
})

test('revoke() removes trust and persists', async () => {
  const { path, cleanup } = tmpFile()
  try {
    const store = new WorkspaceTrustStore(path)
    await store.trust('/home/alice/project')
    await store.revoke('/home/alice/project')
    assert.equal(store.isTrusted('/home/alice/project'), false)
    assert.equal(new WorkspaceTrustStore(path).isTrusted('/home/alice/project'), false)
  } finally {
    cleanup()
  }
})

test('paths are normalized so trailing slashes and .. segments match', async () => {
  const { path, cleanup } = tmpFile()
  try {
    const store = new WorkspaceTrustStore(path)
    await store.trust('/home/alice/project/')
    assert.equal(store.isTrusted('/home/alice/project'), true)
    assert.equal(store.isTrusted('/home/alice/x/../project'), true)
  } finally {
    cleanup()
  }
})

test('an empty path is never trusted', () => {
  const { path, cleanup } = tmpFile()
  try {
    assert.equal(new WorkspaceTrustStore(path).isTrusted(''), false)
  } finally {
    cleanup()
  }
})

test('a malformed trust file is treated as no trust, not a crash', () => {
  const { path, cleanup } = tmpFile()
  try {
    writeFileSync(path, '{ not json', 'utf-8')
    assert.equal(new WorkspaceTrustStore(path).isTrusted('/home/alice/project'), false)
  } finally {
    cleanup()
  }
})
