import assert from 'node:assert/strict'
import { test } from 'node:test'
import { t } from '../../../shared/i18n'
import { openPathRefusalPrompt } from './open-path-refusal'

test('a runnable file offers Show in folder with a reason', () => {
  const prompt = openPathRefusalPrompt('runnable-file', t)
  assert.equal(prompt.followUp, 'reveal')
  assert.equal(prompt.message, 'This file can run as a program, so it is not opened with the system app.')
})

test('a failed editor launch offers the system app', () => {
  assert.equal(openPathRefusalPrompt('launch-failed', t).followUp, 'system')
})

test('other refusals offer no follow-up and have text', () => {
  for (const refusal of ['outside-roots', 'not-found', 'no-terminal-workspace', 'editor-running'] as const) {
    const prompt = openPathRefusalPrompt(refusal, t)
    assert.equal(prompt.followUp, null)
    assert.doesNotMatch(prompt.message, /^openPath\./)
  }
})
