import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runChromiumProbe } from './chromium-probe.test-helper'

const SCENARIO_COUNT = 10

test('the shared model picker preserves selection, focus and session isolation in both engines', async (t) => {
  const run = await runChromiumProbe(new URL('./model-selector.test-fixture.tsx', import.meta.url), 'ModelSelectorProbe')
  assert.equal(run.error, undefined, `${run.error?.message}\n${run.stderr}`)
  assert.equal(run.results.length, SCENARIO_COUNT, run.stderr)
  for (const scenario of run.results) {
    await t.test(scenario.name, () => assert.equal(scenario.error, undefined))
  }
  assert.equal(run.status, 0, run.stderr)
})
