import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { validateRuleList, emptyRule } from './permission-rules-editor-helpers'

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
