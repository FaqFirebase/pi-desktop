import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { OmpUsageResult } from '../shared/ipc-contracts'
import { createOmpUsageLoader, parseOmpUsage } from './omp-usage'

// Trimmed from `omp usage --json` (OMP 18.18) for one Claude subscription.
const ANTHROPIC_REPORT = {
  provider: 'anthropic',
  fetchedAt: 1794485759402,
  limits: [
    {
      id: 'anthropic:5h',
      label: 'Claude 5 Hour',
      window: { id: '5h', label: '5 Hour', durationMs: 18000000, resetsAt: 1794486600900 },
      amount: { used: 21, limit: 100, remaining: 79, usedFraction: 0.21, remainingFraction: 0.79, unit: 'percent' },
      status: 'ok',
    },
  ],
  metadata: { accountId: '6578fef8', email: 'me@example.com', orgName: 'Example Org' },
  resetCredits: {
    availableCount: 3,
    redeemableCount: 1,
    credits: [
      { id: 'b', remainingCount: 1, usable: false, expiresAt: '2027-03-09T07:59:00.000Z' },
      { id: 'a', remainingCount: 1, usable: true, expiresAt: '2026-12-10T22:00:00.000Z' },
      { id: 'spent', remainingCount: 0, expiresAt: '2026-11-20T00:00:00.000Z' },
    ],
  },
}

test('parseOmpUsage maps an account with its limits, saved resets and capacity', () => {
  const output = JSON.stringify({
    generatedAt: 1794485759610,
    reports: [ANTHROPIC_REPORT],
    accountsWithoutUsage: [],
    disabledCredentials: [],
    capacity: {
      anthropic: [
        { window: '5h', durationMs: 18000000, accounts: 2, usedAccounts: 0.21, remainingAccounts: 1.79 },
        { window: '7d', meter: 'fable', accounts: 2, usedAccounts: 0.04, remainingAccounts: 1.96 },
      ],
    },
  })
  assert.deepEqual(parseOmpUsage(output), {
    providers: [
      {
        provider: 'anthropic',
        notes: [],
        accounts: [
          {
            account: 'me@example.com',
            org: 'Example Org',
            limits: [
              { id: 'anthropic:5h', label: 'Claude 5 Hour', usedFraction: 0.21, resetsAt: 1794486600900, status: 'ok' },
            ],
            // A spent credit's expiry is not the soonest one left.
            resets: { available: 3, usable: 1, soonestExpiresAt: Date.parse('2026-12-10T22:00:00.000Z') },
          },
        ],
        accountsWithoutUsage: 0,
        disabled: [],
        capacity: [
          { window: '5h', meter: null, accounts: 2, usedAccounts: 0.21 },
          { window: '7d', meter: 'fable', accounts: 2, usedAccounts: 0.04 },
        ],
      },
    ],
    fetchedAt: 1794485759402,
  })
})

// Trimmed from `omp usage --json` (OMP 18.18): two Ollama Cloud accounts with
// no quota API, an API-key account without usage data, and two disabled logins.
const OLLAMA_NOTE = 'Ollama does not expose a standalone quota usage API; per-response token usage is reported during requests.'
const MIXED_OUTPUT = JSON.stringify({
  generatedAt: 1794572508432,
  reports: [
    { provider: 'ollama-cloud', fetchedAt: 1794572501203, limits: [], notes: [OLLAMA_NOTE] },
    { provider: 'ollama-cloud', fetchedAt: 1794572501203, limits: [], notes: [OLLAMA_NOTE] },
  ],
  accountsWithoutUsage: [{ provider: 'opencode-go', type: 'api_key' }],
  disabledCredentials: [
    {
      id: 3,
      provider: 'xai-oauth',
      type: 'oauth',
      cause: 'oauth refresh failed: invalid_grant',
      email: 'me@example.com',
      accountId: 'acct-x',
      disabledAtMs: 1792522897000,
    },
    {
      id: 7,
      provider: 'anthropic',
      type: 'oauth',
      accountId: 'acct-a',
      orgName: 'Example Org',
    },
  ],
  capacity: {},
})

test('parseOmpUsage groups by provider like omp usage, sorted by provider id', () => {
  assert.deepEqual(parseOmpUsage(MIXED_OUTPUT)?.providers.map((p) => p.provider), [
    'anthropic',
    'ollama-cloud',
    'opencode-go',
    'xai-oauth',
  ])
})

test('parseOmpUsage keeps provider notes once and every account without limits', () => {
  const ollama = parseOmpUsage(MIXED_OUTPUT)?.providers.find((p) => p.provider === 'ollama-cloud')
  assert.deepEqual(ollama?.notes, [OLLAMA_NOTE])
  assert.deepEqual(ollama?.accounts, [
    { account: null, org: null, limits: [], resets: null },
    { account: null, org: null, limits: [], resets: null },
  ])
})

test('parseOmpUsage counts signed-in accounts the provider gives no usage data for', () => {
  const opencode = parseOmpUsage(MIXED_OUTPUT)?.providers.find((p) => p.provider === 'opencode-go')
  assert.equal(opencode?.accountsWithoutUsage, 1)
  assert.deepEqual(opencode?.accounts, [])
})

test('parseOmpUsage reports disabled logins with their name, time and cause', () => {
  const providers = parseOmpUsage(MIXED_OUTPUT)?.providers
  assert.deepEqual(providers?.find((p) => p.provider === 'xai-oauth')?.disabled, [
    { account: 'me@example.com', org: null, disabledAt: 1792522897000, cause: 'oauth refresh failed: invalid_grant' },
  ])
  assert.deepEqual(providers?.find((p) => p.provider === 'anthropic')?.disabled, [
    { account: 'acct-a', org: 'Example Org', disabledAt: null, cause: null },
  ])
})

test('parseOmpUsage resolves the used fraction from whichever amount fields are present', () => {
  const limit = (amount: Record<string, unknown>) => ({ id: 'x', label: 'X', amount })
  const output = JSON.stringify({
    reports: [{
      provider: 'openai-codex',
      limits: [
        limit({ usedFraction: 0.5, used: 1, limit: 100, unit: 'requests' }),
        limit({ used: 30, limit: 60, unit: 'requests' }),
        limit({ used: 12, unit: 'percent' }),
        limit({ remainingFraction: 0.25, unit: 'unknown' }),
        limit({ unit: 'unknown' }),
      ],
    }],
  })
  const fractions = parseOmpUsage(output)?.providers[0].accounts[0].limits.map((l) => l.usedFraction)
  assert.deepEqual(fractions, [0.5, 0.5, 0.12, 0.75, null])
})

test('parseOmpUsage falls back for missing account fields and unknown statuses', () => {
  const output = JSON.stringify({
    reports: [{
      provider: 'zai',
      metadata: { accountId: 'acct-1' },
      limits: [{ id: 'zai:tokens', amount: { unit: 'tokens' }, status: 'throttled' }, { label: 'no id' }],
    }, { limits: [] }],
  })
  const providers = parseOmpUsage(output)?.providers
  assert.deepEqual(providers?.map((p) => p.provider), ['zai'])
  assert.deepEqual(providers?.[0].accounts, [{
    account: 'acct-1',
    org: null,
    limits: [{ id: 'zai:tokens', label: 'zai:tokens', usedFraction: null, resetsAt: null, status: 'unknown' }],
    resets: null,
  }])
})

test('parseOmpUsage reports the oldest account fetch, since OMP caches each report', () => {
  const output = JSON.stringify({
    reports: [
      { provider: 'anthropic', fetchedAt: 1794485759402, limits: [] },
      { provider: 'openai-codex', fetchedAt: 1794485000000, limits: [] },
      { provider: 'zai', limits: [] },
      // Not an account, so its timestamp does not count.
      { fetchedAt: 1, limits: [] },
    ],
  })
  assert.equal(parseOmpUsage(output)?.fetchedAt, 1794485000000)
})

test('parseOmpUsage reads the report behind CLI warnings', () => {
  const output = `warning: extension failed to load\n${JSON.stringify({ reports: [] })}\n`
  assert.deepEqual(parseOmpUsage(output), { providers: [], fetchedAt: null })
})

test('parseOmpUsage returns null for output that is not a usage report', () => {
  assert.equal(parseOmpUsage(''), null)
  assert.equal(parseOmpUsage('Error: not signed in'), null)
  assert.equal(parseOmpUsage('{"npm":[]}'), null)
})

const EMPTY_RESULT: OmpUsageResult = { ok: true, report: { providers: [], fetchedAt: null } }

/** A loader whose reads finish only when the test says so, with a log of the steps run. */
function controlledLoader() {
  const steps: string[] = []
  const pendingReads: Array<() => void> = []
  const load = createOmpUsageLoader({
    read: () => {
      steps.push('read')
      return new Promise((resolve) => pendingReads.push(() => resolve(EMPTY_RESULT)))
    },
    invalidate: async () => {
      steps.push('invalidate')
    },
  })
  // A run starts its read asynchronously, so let it reach the read first.
  const finishRead = async (): Promise<void> => {
    await settle()
    pendingReads.shift()?.()
    await settle()
  }
  return { load, steps, finishRead }
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

test('a usage load reads the cache; a refresh drops it first', async () => {
  const { load, steps, finishRead } = controlledLoader()
  const cached = load(false)
  await finishRead()
  assert.equal(await cached, EMPTY_RESULT)
  const fresh = load(true)
  await finishRead()
  await fresh
  assert.deepEqual(steps, ['read', 'invalidate', 'read'])
})

test('loads during a run share it, and a refresh during a cached read runs after it', async () => {
  const { load, steps, finishRead } = controlledLoader()
  const first = load(false)
  const shared = load(false)
  assert.equal(shared, first)
  const refresh = load(true)
  // A refresh is already queued, so another one shares it.
  assert.equal(load(true), refresh)
  assert.equal(load(false), refresh)
  await settle()
  assert.deepEqual(steps, ['read'])
  await finishRead()
  await finishRead()
  await refresh
  assert.deepEqual(steps, ['read', 'invalidate', 'read'])
})
