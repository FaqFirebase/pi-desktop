import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isSubagentTool, subagentAgentName, subagentTaskText } from './store'

/**
 * Pi delegates via the `pi-subagents` package (`subagent`, `subagent_wait`);
 * OMP has delegation built in and calls it `task`. The progress strip matched
 * only the Pi names, so under OMP it stayed empty while subagents ran.
 */

test('both engines spawn tools are recognized', () => {
  assert.equal(isSubagentTool('subagent'), true)
  assert.equal(isSubagentTool('subagent_wait'), true)
  // The regression: OMP's spawn tools used to fall through unrecognized.
  assert.equal(isSubagentTool('task'), true)
  // `hub` is the one a plain "use the reviewer agent" request calls, seen on
  // the wire fanning out five reviewers while the strip showed nothing.
  assert.equal(isSubagentTool('hub'), true)
})

test('ordinary tools are not treated as spawns', () => {
  for (const name of ['read', 'grep', 'glob', 'bash', 'edit', 'write', 'todo', 'eval']) {
    assert.equal(isSubagentTool(name), false, `${name} must not be a spawn`)
  }
})

test('the agent label is read from whichever key the engine used', () => {
  assert.equal(subagentAgentName({ agent: 'reviewer' }), 'reviewer')
  assert.equal(subagentAgentName({ agentType: 'scout' }), 'scout')
  assert.equal(subagentAgentName({ subagent_type: 'librarian' }), 'librarian')
})

test('an unlabelled spawn still gets a row rather than being dropped', () => {
  assert.equal(subagentAgentName({}), 'subagent')
  assert.equal(subagentAgentName(undefined), 'subagent')
  // Whitespace is not a label.
  assert.equal(subagentAgentName({ agent: '   ' }), 'subagent')
})

test('the task caption is read from whichever key the engine used', () => {
  assert.equal(subagentTaskText({ task: 'audit the parser' }), 'audit the parser')
  assert.equal(subagentTaskText({ prompt: 'audit the parser' }), 'audit the parser')
  assert.equal(subagentTaskText({ description: 'audit the parser' }), 'audit the parser')
  assert.equal(subagentTaskText({}), '')
})

test('the first matching key wins so a label is stable', () => {
  assert.equal(subagentAgentName({ agent: 'reviewer', agentType: 'scout' }), 'reviewer')
  assert.equal(subagentTaskText({ task: 'first', prompt: 'second' }), 'first')
})

test('non-string arguments never leak into the label', () => {
  assert.equal(subagentAgentName({ agent: 42 } as Record<string, unknown>), 'subagent')
  assert.equal(subagentTaskText({ task: { nested: true } } as Record<string, unknown>), '')
})
