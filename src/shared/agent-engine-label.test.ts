import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_AGENT_ENGINE_LABEL, agentEngineLabel } from './agent-engine-label'

/**
 * The status bar named "Pi" while OMP was the configured engine, because the
 * label came from a store default that only a running agent ever corrected.
 * Every surface that names the agent now reads this one map.
 */

test('each engine has its own display name', () => {
  assert.equal(agentEngineLabel('pi'), 'Pi')
  assert.equal(agentEngineLabel('omp'), 'OMP')
})

test('an unknown engine has no name, so callers choose their own fallback', () => {
  // Session rows show nothing rather than guess; the status bar falls back to
  // the default. Returning a name here would tag rows with the wrong CLI.
  assert.equal(agentEngineLabel(null), null)
  assert.equal(agentEngineLabel(undefined), null)
})

test('the fallback is a real engine name, not a placeholder', () => {
  // The permission extension renders this when the GUI told it nothing.
  assert.equal(DEFAULT_AGENT_ENGINE_LABEL, 'Pi')
  assert.equal(agentEngineLabel('pi'), DEFAULT_AGENT_ENGINE_LABEL)
})
