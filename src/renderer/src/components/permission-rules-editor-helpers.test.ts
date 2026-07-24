import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { validateRuleList, emptyRule, shouldPersistScope } from './permission-rules-editor-helpers'

describe('validateRuleList', () => {
  it('returns null for a valid list', () => {
    assert.equal(validateRuleList([{ action: 'allow', tool: 'bash', match: 'npm *' }]), null)
    assert.equal(validateRuleList([{ action: 'deny', tool: '*' }]), null)
    assert.equal(validateRuleList([]), null)
  })

  it('flags a rule with an empty tool, by row number', () => {
    assert.match(validateRuleList([{ action: 'deny', tool: '  ' }]) ?? '', /rule 1/i)
    assert.match(
      validateRuleList([
        { action: 'deny', tool: 'bash' },
        { action: 'allow', tool: '' },
      ]) ?? '',
      /rule 2/i
    )
  })
})

describe('emptyRule', () => {
  it('creates a fresh ask-nothing allow rule for the add button', () => {
    assert.deepEqual(emptyRule(), { action: 'allow', tool: '', match: '' })
  })
})

describe('shouldPersistScope', () => {
  it('persists when the user has a draft, regardless of file state', () => {
    assert.ok(shouldPersistScope([], false, false))
    assert.ok(shouldPersistScope([{ action: 'deny', tool: 'bash' }], false, true))
  })
  it('persists an existing, successfully loaded file (row deletions save)', () => {
    assert.ok(shouldPersistScope(null, true, true))
  })
  it('never creates a file the user did not edit', () => {
    assert.ok(!shouldPersistScope(null, true, false))
  })
  it('never overwrites a corrupt file the user has not taken ownership of', () => {
    assert.ok(!shouldPersistScope(null, false, true))
  })
})
