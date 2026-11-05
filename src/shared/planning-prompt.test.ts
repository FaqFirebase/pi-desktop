import assert from 'node:assert/strict'
import { sessionPreview, stripInjectedPreamble } from './session-preview'
import { buildPlanningPrompt } from './planning-prompt'

const prompt = buildPlanningPrompt('Delete unused files')


// The preamble is stored verbatim as the session's first user message, so the
// builder must stay strippable: if its opening line or request sentinel drifts,
// every planning session's row title silently reverts to the boilerplate.
assert.equal(stripInjectedPreamble(prompt), 'Delete unused files')

const multiLineRequest = 'Fix the token refresh.\n\nIt drops the retry on 401.'
assert.equal(stripInjectedPreamble(buildPlanningPrompt(multiLineRequest)), multiLineRequest)

assert.equal(
  sessionPreview(stripInjectedPreamble(buildPlanningPrompt('Wire up the token refresh retry'))),
  'Wire up the token refresh retry'
)

// The regression this pairing prevents: unstripped, every planning session
// previews as the same ~410 characters of preamble.
assert.notEqual(
  sessionPreview(stripInjectedPreamble(buildPlanningPrompt('Refactor auth'))),
  sessionPreview(stripInjectedPreamble(buildPlanningPrompt('Write unit tests')))
)
