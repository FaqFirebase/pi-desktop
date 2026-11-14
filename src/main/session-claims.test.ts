import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLAIM_STALE_MS, SessionClaimStore, type SessionClaimDeps } from './session-claims'

const SESSION = join(tmpdir(), 'sessions', 'project', 'session-a.jsonl')
const OTHER_SESSION = join(tmpdir(), 'sessions', 'project', 'session-b.jsonl')
const APP_A_PID = 101
const APP_B_PID = 202
/** File times can trail the clock a little, so tests stay this far from the stale limit. */
const CLOCK_SLACK_MS = 1_000

interface World {
  dir: string
  alive: Set<number>
  clock: { now: number }
  app: (pid: number) => SessionClaimStore
}

function world(): World {
  const dir = mkdtempSync(join(tmpdir(), 'pi-session-claims-'))
  const alive = new Set([APP_A_PID, APP_B_PID])
  const clock = { now: Date.now() }
  const app = (pid: number): SessionClaimStore => {
    const deps: SessionClaimDeps = { pid, now: () => clock.now, isProcessAlive: (candidate) => alive.has(candidate) }
    return new SessionClaimStore(dir, deps)
  }
  return { dir, alive, clock, app }
}

function claimFiles(dir: string): string[] {
  return readdirSync(dir)
}

test('a session claimed by one app cannot be claimed by another until it is released', () => {
  const { dir, app } = world()
  try {
    const appA = app(APP_A_PID)
    const appB = app(APP_B_PID)
    assert.equal(appA.claim(SESSION), true)
    assert.equal(appA.claim(SESSION), true, 'claiming again is free')
    assert.equal(appB.claim(SESSION), false)
    assert.equal(appB.claim(OTHER_SESSION), true, 'other sessions stay free')
    appA.release(SESSION)
    assert.equal(appB.claim(SESSION), true)
    // No private temporary file is left behind.
    assert.equal(claimFiles(dir).length, 2)
    appB.release(SESSION)
    appB.release(OTHER_SESSION)
    assert.deepEqual(claimFiles(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('releasing a claim this app does not hold leaves the owner alone', () => {
  const { dir, app } = world()
  try {
    const appA = app(APP_A_PID)
    const appB = app(APP_B_PID)
    assert.equal(appA.claim(SESSION), true)
    appB.release(SESSION)
    assert.equal(appB.claim(SESSION), false)
    appA.release(SESSION)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a claim of an app that is gone does not block', () => {
  const { dir, alive, app } = world()
  try {
    assert.equal(app(APP_A_PID).claim(SESSION), true)
    alive.delete(APP_A_PID)
    assert.equal(app(APP_B_PID).claim(SESSION), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a claim that is not refreshed goes stale, so a reused pid does not block forever', () => {
  const { dir, clock, app } = world()
  try {
    const appA = app(APP_A_PID)
    const appB = app(APP_B_PID)
    assert.equal(appA.claim(SESSION), true)
    clock.now += CLAIM_STALE_MS - CLOCK_SLACK_MS
    assert.equal(appB.claim(SESSION), false, 'still fresh')
    // The owner marks its claim as in use, so it stays held.
    appA.refresh()
    clock.now += CLAIM_STALE_MS - CLOCK_SLACK_MS
    assert.equal(appB.claim(SESSION), false, 'refreshed claims stay held')
    clock.now += CLAIM_STALE_MS
    assert.equal(appB.claim(SESSION), true, 'an owner that stopped refreshing lost it')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a claim file removed from outside is dropped on refresh', () => {
  const { dir, app } = world()
  try {
    const appA = app(APP_A_PID)
    assert.equal(appA.claim(SESSION), true)
    for (const file of claimFiles(dir)) rmSync(join(dir, file))
    appA.refresh()
    assert.equal(app(APP_B_PID).claim(SESSION), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('two apps that find the same stale claim do not both take it', () => {
  const { dir, alive, clock } = world()
  const DEAD_PID = 303
  try {
    const store = (pid: number, isProcessAlive: (candidate: number) => boolean): SessionClaimStore =>
      new SessionClaimStore(dir, { pid, now: () => clock.now, isProcessAlive })
    assert.equal(store(DEAD_PID, () => true).claim(SESSION), true)
    alive.delete(DEAD_PID)

    // App B finds the claim stale; while it decides, app A takes it over.
    const appA = store(APP_A_PID, (candidate) => alive.has(candidate))
    let raced = false
    const appB = store(APP_B_PID, (candidate) => {
      if (!raced) {
        raced = true
        assert.equal(appA.claim(SESSION), true)
      }
      return alive.has(candidate)
    })
    assert.equal(appB.claim(SESSION), false, 'the newer claim is left to app A')
    assert.equal(store(APP_B_PID, (candidate) => alive.has(candidate)).claim(SESSION), false, 'app A still holds it')
    assert.equal(claimFiles(dir).length, 1, 'nothing is left aside')
    appA.release(SESSION)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
