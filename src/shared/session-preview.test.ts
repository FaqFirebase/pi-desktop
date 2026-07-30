import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MAX_PREVIEW_CHARS,
  PLANNING_PREAMBLE_OPENING,
  PLANNING_PREAMBLE_SENTINEL,
  sessionPreview,
  stripInjectedPreamble,
} from './session-preview'

/**
 * Stands in for the renderer's `buildPlanningPrompt`, which shared code may not
 * import. `planning-prompt.test.ts` guards that the real builder still matches.
 */
const injectedPrompt = (request: string): string =>
  [
    PLANNING_PREAMBLE_OPENING,
    '',
    'Return a step-by-step plan before any implementation.',
    '',
    PLANNING_PREAMBLE_SENTINEL,
    request,
  ].join('\n')

test('sessionPreview collapses newlines and runs of whitespace', () => {
  assert.equal(
    sessionPreview('Refactor auth\n\n  module   login\tlogic'),
    'Refactor auth module login logic'
  )
})

test('sessionPreview trims surrounding whitespace', () => {
  assert.equal(sessionPreview('\n  Fix token refresh  \n'), 'Fix token refresh')
})

test('sessionPreview returns null for text with no visible characters', () => {
  assert.equal(sessionPreview('   \n\t  '), null)
  assert.equal(sessionPreview(''), null)
})

test('sessionPreview leaves text at the cap unchanged', () => {
  const exact = 'a'.repeat(MAX_PREVIEW_CHARS)
  assert.equal(sessionPreview(exact), exact)
})

test('sessionPreview truncates over-long text and marks the cut', () => {
  const long = 'a'.repeat(MAX_PREVIEW_CHARS + 50)
  const preview = sessionPreview(long)!
  // The ellipsis signals truncation without inflating the payload past the cap.
  assert.ok(preview.endsWith('…'), `expected an ellipsis, got ${JSON.stringify(preview.slice(-8))}`)
  assert.equal(Array.from(preview).length, MAX_PREVIEW_CHARS + 1)
  assert.ok(long.startsWith(preview.slice(0, -1)))
})

test('sessionPreview does not split a surrogate pair when truncating', () => {
  // Each rocket is one code point but two UTF-16 units; a naive slice(0, N)
  // cuts the pair and yields a lone replacement char.
  const rockets = '🚀'.repeat(MAX_PREVIEW_CHARS + 10)
  const preview = sessionPreview(rockets)!
  assert.ok(!preview.includes('�'), 'preview contains a replacement character')
  assert.equal(preview, '🚀'.repeat(MAX_PREVIEW_CHARS) + '…')
})

test('stripInjectedPreamble recovers the request from a planning-mode prompt', () => {
  assert.equal(
    stripInjectedPreamble(injectedPrompt('Add a remember-me checkbox')),
    'Add a remember-me checkbox'
  )
})

test('stripInjectedPreamble leaves an ordinary message untouched', () => {
  const plain = 'Explain this project structure'
  assert.equal(stripInjectedPreamble(plain), plain)
})

test('stripInjectedPreamble keeps a message that merely mentions the sentinel', () => {
  // Only a message that *opens* with the injected preamble may be stripped;
  // otherwise a user writing "User request:" would lose everything before it.
  const plain = 'Here is the User request: format we should adopt'
  assert.equal(stripInjectedPreamble(plain), plain)
})

test('stripInjectedPreamble keeps the preamble when no request follows it', () => {
  // Degenerate but real: stripping would leave an empty preview, which is worse
  // than showing the boilerplate.
  const preambleOnly = injectedPrompt('')
  assert.equal(stripInjectedPreamble(preambleOnly), preambleOnly)
})

test('a planning prompt previews as the user request alone', () => {
  const prompt = injectedPrompt('  Wire up the token refresh retry  ')
  assert.equal(sessionPreview(stripInjectedPreamble(prompt)), 'Wire up the token refresh retry')
})
