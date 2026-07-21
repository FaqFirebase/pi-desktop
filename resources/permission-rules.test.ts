import { strict as assert } from 'node:assert'
import { describe, it, beforeEach } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PERMISSION_RULES_VERSION,
  WORKSPACE_RULES_DIR_NAME,
  validatePermissionRulesFile,
  globToRegExp,
  getPrimaryInput,
  evaluateRules,
  decideToolCall,
  needsPermissionsExtension,
  workspaceRulesPath,
  loadEffectiveRules,
  clearRulesCache,
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

describe('getPrimaryInput', () => {
  it('uses command for bash', () => {
    assert.deepEqual(getPrimaryInput('bash', { command: 'ls -la' }), { value: 'ls -la', kind: 'command' })
  })

  it('uses path for tools with a path input', () => {
    assert.deepEqual(getPrimaryInput('edit', { path: 'src/a.ts', old: 'x' }), { value: 'src/a.ts', kind: 'path' })
    assert.deepEqual(getPrimaryInput('read', { path: '/etc/hosts' }), { value: '/etc/hosts', kind: 'path' })
  })

  it('falls back to JSON for anything else', () => {
    assert.deepEqual(getPrimaryInput('fetch', { url: 'https://x' }), { value: '{"url":"https://x"}', kind: 'json' })
    assert.deepEqual(getPrimaryInput('bash', undefined), { value: 'null', kind: 'json' })
  })
})

describe('evaluateRules', () => {
  const LINUX = 'linux'
  const rules = [
    { action: 'allow' as const, tool: 'bash', match: 'npm test*' },
    { action: 'deny' as const, tool: 'bash', match: 'rm -rf *' },
    { action: 'deny' as const, tool: '*', match: '*.env*' },
    { action: 'allow' as const, tool: 'grep' },
  ]

  it('returns deny when a deny rule matches, with the matching rule', () => {
    const result = evaluateRules(rules, 'bash', { command: 'rm -rf /tmp/x' }, LINUX)
    assert.equal(result.decision, 'deny')
    if (result.decision === 'deny') assert.equal(result.rule.match, 'rm -rf *')
  })

  it('deny beats allow regardless of rule order', () => {
    const both = [
      { action: 'allow' as const, tool: 'bash', match: 'rm *' },
      { action: 'deny' as const, tool: 'bash', match: 'rm *' },
    ]
    assert.equal(evaluateRules(both, 'bash', { command: 'rm x' }, LINUX).decision, 'deny')
    assert.equal(evaluateRules(both.slice().reverse(), 'bash', { command: 'rm x' }, LINUX).decision, 'deny')
  })

  it('returns allow when only an allow rule matches', () => {
    assert.equal(evaluateRules(rules, 'bash', { command: 'npm test --run' }, LINUX).decision, 'allow')
  })

  it('a rule without match applies to every invocation of its tool', () => {
    assert.equal(evaluateRules(rules, 'grep', { pattern: 'x' }, LINUX).decision, 'allow')
  })

  it('tool "*" applies the rule to every tool', () => {
    assert.equal(evaluateRules(rules, 'write', { path: 'app/.env.local' }, LINUX).decision, 'deny')
  })

  it('returns default when nothing matches', () => {
    assert.equal(evaluateRules(rules, 'bash', { command: 'ls' }, LINUX).decision, 'default')
  })

  it('path matching normalizes backslashes and is case-insensitive on win32/darwin', () => {
    const pathRules = [{ action: 'deny' as const, tool: '*', match: '*/secrets/*' }]
    assert.equal(evaluateRules(pathRules, 'read', { path: 'C:\\proj\\secrets\\k.txt' }, 'win32').decision, 'deny')
    assert.equal(evaluateRules(pathRules, 'read', { path: 'C:\\proj\\SECRETS\\k.txt' }, 'win32').decision, 'deny')
    assert.equal(evaluateRules(pathRules, 'read', { path: '/proj/SECRETS/k.txt' }, 'darwin').decision, 'deny')
    assert.equal(evaluateRules(pathRules, 'read', { path: '/proj/SECRETS/k.txt' }, 'linux').decision, 'default')
  })

  it('command matching stays case-sensitive on all platforms', () => {
    const cmdRules = [{ action: 'deny' as const, tool: 'bash', match: 'RM *' }]
    assert.equal(evaluateRules(cmdRules, 'bash', { command: 'rm x' }, 'win32').decision, 'default')
  })
})

describe('decideToolCall', () => {
  const rules = [
    { action: 'allow' as const, tool: 'bash', match: 'npm test*' },
    { action: 'deny' as const, tool: 'bash', match: 'rm -rf *' },
  ]

  it('deny rules block in every mode, including trusted and plan-readonly', () => {
    for (const mode of ['trusted', 'plan-readonly', 'ask-edits', 'ask-commands', undefined]) {
      const result = decideToolCall(mode, rules, 'bash', { command: 'rm -rf /' }, 'linux')
      assert.equal(result.action, 'block')
      if (result.action === 'block') assert.match(result.reason, /rm -rf \*/)
    }
  })

  it('allow rules skip the prompt in ask modes', () => {
    assert.deepEqual(decideToolCall('ask-commands', rules, 'bash', { command: 'npm test' }, 'linux'), { action: 'allow' })
  })

  it('preserves mode defaults when no rule matches', () => {
    assert.deepEqual(decideToolCall('ask-edits', [], 'edit', { path: 'a' }, 'linux'), { action: 'prompt' })
    assert.deepEqual(decideToolCall('ask-edits', [], 'write', { path: 'a' }, 'linux'), { action: 'prompt' })
    assert.deepEqual(decideToolCall('ask-edits', [], 'bash', { command: 'x' }, 'linux'), { action: 'prompt' })
    assert.deepEqual(decideToolCall('ask-edits', [], 'read', { path: 'a' }, 'linux'), { action: 'allow' })
    assert.deepEqual(decideToolCall('ask-commands', [], 'bash', { command: 'x' }, 'linux'), { action: 'prompt' })
    assert.deepEqual(decideToolCall('ask-commands', [], 'edit', { path: 'a' }, 'linux'), { action: 'allow' })
    assert.deepEqual(decideToolCall('trusted', [], 'bash', { command: 'x' }, 'linux'), { action: 'allow' })
    assert.deepEqual(decideToolCall(undefined, [], 'bash', { command: 'x' }, 'linux'), { action: 'allow' })
  })
})

describe('needsPermissionsExtension', () => {
  it('loads for ask modes regardless of rules', () => {
    assert.ok(needsPermissionsExtension('ask-edits', false))
    assert.ok(needsPermissionsExtension('ask-commands', false))
  })
  it('loads in any mode when a rules file exists', () => {
    assert.ok(needsPermissionsExtension('trusted', true))
    assert.ok(needsPermissionsExtension('plan-readonly', true))
  })
  it('stays off for trusted/plan-readonly without rules', () => {
    assert.ok(!needsPermissionsExtension('trusted', false))
    assert.ok(!needsPermissionsExtension('plan-readonly', false))
  })
})

describe('loadEffectiveRules', () => {
  const makeTmpDir = (): string => mkdtempSync(join(tmpdir(), 'pi-perm-rules-'))
  const writeRules = (filePath: string, rules: unknown): void => {
    writeFileSync(filePath, JSON.stringify({ version: 1, rules }), 'utf-8')
  }

  beforeEach(() => clearRulesCache())

  it('returns none when neither file exists', () => {
    const dir = makeTmpDir()
    try {
      const result = loadEffectiveRules(dir, join(dir, 'nope.json'))
      assert.deepEqual(result, { rules: [], source: 'none' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('loads global rules when no workspace file exists', () => {
    const dir = makeTmpDir()
    try {
      const globalPath = join(dir, 'permission-rules.json')
      writeRules(globalPath, [{ action: 'deny', tool: 'bash' }])
      const result = loadEffectiveRules(dir, globalPath)
      assert.equal(result.source, 'global')
      assert.equal(result.rules.length, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('workspace file fully replaces global rules', () => {
    const dir = makeTmpDir()
    try {
      const globalPath = join(dir, 'global.json')
      writeRules(globalPath, [{ action: 'deny', tool: 'bash' }])
      mkdirSync(join(dir, WORKSPACE_RULES_DIR_NAME))
      writeRules(workspaceRulesPath(dir), [{ action: 'allow', tool: 'grep' }])
      const result = loadEffectiveRules(dir, globalPath)
      assert.equal(result.source, 'workspace')
      assert.deepEqual(result.rules, [{ action: 'allow', tool: 'grep' }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('malformed global file yields no rules plus an error', () => {
    const dir = makeTmpDir()
    try {
      const globalPath = join(dir, 'global.json')
      writeFileSync(globalPath, '{ not json', 'utf-8')
      const result = loadEffectiveRules(null, globalPath)
      assert.equal(result.source, 'global')
      assert.deepEqual(result.rules, [])
      assert.ok(result.error)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('malformed workspace file falls back to global rules, keeping the error', () => {
    const dir = makeTmpDir()
    try {
      const globalPath = join(dir, 'global.json')
      writeRules(globalPath, [{ action: 'deny', tool: 'bash' }])
      mkdirSync(join(dir, WORKSPACE_RULES_DIR_NAME))
      writeFileSync(workspaceRulesPath(dir), '{ not json', 'utf-8')
      const result = loadEffectiveRules(dir, globalPath)
      assert.equal(result.source, 'global')
      assert.equal(result.rules.length, 1)
      assert.ok(result.error)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('re-reads when mtime changes and caches when it does not', () => {
    const dir = makeTmpDir()
    try {
      const globalPath = join(dir, 'global.json')
      writeRules(globalPath, [{ action: 'deny', tool: 'bash' }])
      assert.equal(loadEffectiveRules(null, globalPath).rules.length, 1)
      writeRules(globalPath, [
        { action: 'deny', tool: 'bash' },
        { action: 'deny', tool: 'edit' },
      ])
      // Force a distinct mtime even on coarse-grained filesystems.
      const future = new Date(Date.now() + 5000)
      utimesSync(globalPath, future, future)
      assert.equal(loadEffectiveRules(null, globalPath).rules.length, 2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('file deleted after caching falls back to none', () => {
    const dir = makeTmpDir()
    try {
      const globalPath = join(dir, 'global.json')
      writeRules(globalPath, [])
      assert.equal(loadEffectiveRules(null, globalPath).source, 'global')
      rmSync(globalPath)
      assert.equal(loadEffectiveRules(null, globalPath).source, 'none')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
