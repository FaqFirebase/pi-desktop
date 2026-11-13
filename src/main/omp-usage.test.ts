import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseOmpUsage } from './omp-usage'

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
    accounts: [
      {
        provider: 'anthropic',
        account: 'me@example.com',
        org: 'Example Org',
        limits: [
          { id: 'anthropic:5h', label: 'Claude 5 Hour', usedFraction: 0.21, resetsAt: 1794486600900, status: 'ok' },
        ],
        // A spent credit's expiry is not the soonest one left.
        resets: { available: 3, usable: 1, soonestExpiresAt: Date.parse('2026-12-10T22:00:00.000Z') },
      },
    ],
    capacity: [
      { provider: 'anthropic', window: '5h', meter: null, accounts: 2, usedAccounts: 0.21 },
      { provider: 'anthropic', window: '7d', meter: 'fable', accounts: 2, usedAccounts: 0.04 },
    ],
    fetchedAt: 1794485759402,
  })
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
  const fractions = parseOmpUsage(output)?.accounts[0].limits.map((l) => l.usedFraction)
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
  assert.deepEqual(parseOmpUsage(output)?.accounts, [{
    provider: 'zai',
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
  assert.deepEqual(parseOmpUsage(output), { accounts: [], capacity: [], fetchedAt: null })
})

test('parseOmpUsage returns null for output that is not a usage report', () => {
  assert.equal(parseOmpUsage(''), null)
  assert.equal(parseOmpUsage('Error: not signed in'), null)
  assert.equal(parseOmpUsage('{"npm":[]}'), null)
})
