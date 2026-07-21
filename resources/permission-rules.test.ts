import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import {
  PERMISSION_RULES_VERSION,
  validatePermissionRulesFile,
  globToRegExp,
} from './permission-rules'

describe('validatePermissionRulesFile', () => {
  it('accepts a valid file and returns it typed', () => {
    const file = validatePermissionRulesFile({
      version: 1,
      rules: [
        { action: 'allow', tool: 'bash', match: 'npm test*' },
        { action: 'deny', tool: '*' },
      ],
    })
    assert.equal(file.version, PERMISSION_RULES_VERSION)
    assert.equal(file.rules.length, 2)
    assert.equal(file.rules[1].match, undefined)
  })

  it('accepts an empty rules array', () => {
    assert.deepEqual(validatePermissionRulesFile({ version: 1, rules: [] }).rules, [])
  })

  it('rejects non-objects, arrays, and null', () => {
    for (const bad of [null, 42, 'x', [], undefined]) {
      assert.throws(() => validatePermissionRulesFile(bad), /object/)
    }
  })

  it('rejects unknown top-level keys (typo protection)', () => {
    assert.throws(
      () => validatePermissionRulesFile({ version: 1, rules: [], extra: true }),
      /unknown key "extra"/
    )
  })

  it('rejects wrong or missing version', () => {
    assert.throws(() => validatePermissionRulesFile({ version: 2, rules: [] }), /version/)
    assert.throws(() => validatePermissionRulesFile({ rules: [] }), /version/)
  })

  it('rejects a rule with an unknown action', () => {
    assert.throws(
      () => validatePermissionRulesFile({ version: 1, rules: [{ action: 'actoin', tool: 'bash' }] }),
      /action/
    )
  })

  it('rejects a rule with unknown keys (typo protection)', () => {
    assert.throws(
      () =>
        validatePermissionRulesFile({
          version: 1,
          rules: [{ action: 'deny', tool: 'bash', mach: 'rm *' }],
        }),
      /unknown key "mach"/
    )
  })

  it('rejects empty or non-string tool and non-string match', () => {
    assert.throws(() => validatePermissionRulesFile({ version: 1, rules: [{ action: 'deny', tool: '' }] }), /tool/)
    assert.throws(() => validatePermissionRulesFile({ version: 1, rules: [{ action: 'deny', tool: 7 }] }), /tool/)
    assert.throws(
      () => validatePermissionRulesFile({ version: 1, rules: [{ action: 'deny', tool: 'bash', match: 3 }] }),
      /match/
    )
  })
})

describe('globToRegExp', () => {
  it('matches literal text exactly (anchored)', () => {
    assert.ok(globToRegExp('npm test', false).test('npm test'))
    assert.ok(!globToRegExp('npm test', false).test('npm test --watch'))
    assert.ok(!globToRegExp('npm test', false).test('x npm test'))
  })

  it('* matches any sequence including empty, spaces, slashes, and newlines', () => {
    assert.ok(globToRegExp('npm *', false).test('npm run build'))
    assert.ok(globToRegExp('rm -rf *', false).test('rm -rf /'))
    assert.ok(globToRegExp('git *', false).test('git commit -m "line1\nline2"'))
    assert.ok(globToRegExp('a*b', false).test('ab'))
  })

  it('escapes regex metacharacters in the pattern', () => {
    assert.ok(globToRegExp('foo.sh', false).test('foo.sh'))
    assert.ok(!globToRegExp('foo.sh', false).test('fooXsh'))
    assert.ok(globToRegExp('a+b (c) [d] {e} ^$ |?', false).test('a+b (c) [d] {e} ^$ |?'))
  })

  it('honors case sensitivity flag', () => {
    assert.ok(!globToRegExp('*.env*', false).test('.ENV'))
    assert.ok(globToRegExp('*.env*', true).test('.ENV'))
  })
})
