import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TOKEN_NAMES, SEED_NAMES, SEED_TO_TOKEN, DERIVED_TOKENS, cssVarForToken,
} from './tokens'

test('every token is either seed-backed or derived', () => {
  const seedBacked = new Set(Object.values(SEED_TO_TOKEN))
  for (const token of TOKEN_NAMES) {
    assert.ok(
      seedBacked.has(token) || token in DERIVED_TOKENS,
      `token ${token} has no seed and no derivation`,
    )
  }
})

test('derivations reference only known token variables', () => {
  const known = new Set(TOKEN_NAMES.map(cssVarForToken))
  for (const [token, template] of Object.entries(DERIVED_TOKENS)) {
    const refs = template.match(/--color-[a-z-]+/g) ?? []
    for (const ref of refs) {
      assert.ok(known.has(ref), `${token} references unknown ${ref}`)
    }
  }
})

test('seed names map onto real tokens', () => {
  for (const seed of SEED_NAMES) {
    assert.ok((TOKEN_NAMES as readonly string[]).includes(SEED_TO_TOKEN[seed]))
  }
})

test('cssVarForToken formats names', () => {
  assert.equal(cssVarForToken('surface-hover'), '--color-surface-hover')
})
