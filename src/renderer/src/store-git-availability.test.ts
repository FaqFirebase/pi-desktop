import { before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import type { GitAvailability } from '../../shared/ipc-contracts'

let next: GitAvailability = { status: 'missing' }
let failure: Error | null = null
/** When set, `gitCheck.get` waits for this answer instead of returning `next`. */
let slowGet: Promise<GitAvailability> | null = null
let useAppStore: typeof import('./store')['useAppStore']

async function answer(): Promise<GitAvailability> {
  if (failure) throw failure
  return next
}

before(async () => {
  Object.assign(globalThis, {
    window: { piDesktop: { gitCheck: { get: () => slowGet ?? answer(), recheck: answer } } },
  })
  ;({ useAppStore } = await import('./store'))
})

beforeEach(() => {
  failure = null
  slowGet = null
  useAppStore.setState({ gitAvailability: null, gitBannerDismissed: false, gitCheckRunning: false })
})

test('loadGitAvailability keeps the main process result', async () => {
  next = { status: 'missing' }
  await useAppStore.getState().loadGitAvailability()
  assert.deepEqual(useAppStore.getState().gitAvailability, { status: 'missing' })
})

test('recheckGitAvailability replaces the result and clears the running flag', async () => {
  next = { status: 'found', version: '2.47.1' }
  const pending = useAppStore.getState().recheckGitAvailability()
  assert.equal(useAppStore.getState().gitCheckRunning, true)
  await pending
  assert.equal(useAppStore.getState().gitCheckRunning, false)
  assert.deepEqual(useAppStore.getState().gitAvailability, { status: 'found', version: '2.47.1' })
})

test('recheckGitAvailability clears the running flag when the call fails', async () => {
  useAppStore.setState({ gitAvailability: { status: 'missing' } })
  failure = new Error('ipc down')
  await useAppStore.getState().recheckGitAvailability()
  assert.equal(useAppStore.getState().gitCheckRunning, false)
  assert.deepEqual(useAppStore.getState().gitAvailability, { status: 'missing' })
})

test('a startup check that ends after Check again does not replace the newer result', async () => {
  let finishStartup!: (result: GitAvailability) => void
  slowGet = new Promise((done) => { finishStartup = done })
  const startup = useAppStore.getState().loadGitAvailability()
  next = { status: 'found', version: '2.47.1' }
  await useAppStore.getState().recheckGitAvailability()
  finishStartup({ status: 'missing' })
  await startup
  assert.deepEqual(useAppStore.getState().gitAvailability, { status: 'found', version: '2.47.1' })
})

test('dismissGitBanner hides the banner for this run only', () => {
  useAppStore.getState().dismissGitBanner()
  assert.equal(useAppStore.getState().gitBannerDismissed, true)
})
