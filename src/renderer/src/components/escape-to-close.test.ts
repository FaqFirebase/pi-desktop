import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runChromiumProbe } from './chromium-probe.test-helper'

const SCENARIO_COUNT = 5

test('Escape that closes a menu or a modal does not stop the running turn', async (t) => {
  const run = await runChromiumProbe(new URL('./escape-to-close.test-fixture.tsx', import.meta.url), 'EscapeToCloseProbe')
  assert.equal(run.error, undefined, `${run.error?.message}\n${run.stderr}`)
  assert.equal(run.results.length, SCENARIO_COUNT, run.stderr)
  for (const scenario of run.results) {
    await t.test(scenario.name, () => assert.equal(scenario.error, undefined))
  }
  assert.equal(run.status, 0, run.stderr)
})
