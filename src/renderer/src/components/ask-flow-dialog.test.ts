import test from 'node:test'
import assert from 'node:assert/strict'
import {
  draftsToAnswers,
  effectiveQuestionType,
  emptyDrafts,
  isFlowComplete,
  isMultiQuestion,
  type AskDraftMap,
} from './ask-flow-dialog'
import type { RelayAskQuestion } from '../../../shared/relay-protocol'

const single = (required: boolean, id = 'q1'): RelayAskQuestion => ({
  id,
  label: 'Which branch?',
  prompt: 'Pick one',
  type: 'single',
  required,
  options: [
    { value: 'main', label: 'main' },
    { value: 'dev', label: 'dev' },
  ],
})

const multi = (required: boolean, id = 'q2'): RelayAskQuestion => ({
  id,
  label: 'Which checks?',
  prompt: 'Pick any',
  type: 'multi',
  required,
  options: [
    { value: 'lint', label: 'lint' },
    { value: 'test', label: 'test' },
  ],
})

test('a required question with no answer keeps the flow incomplete', () => {
  const questions = [single(true)]
  // pi-ask rejects a partial flow outright, so submitting here would fail the turn.
  assert.equal(isFlowComplete(questions, emptyDrafts(questions)), false)
})

test('a required question is satisfied by a selected value', () => {
  const questions = [single(true)]
  const drafts = emptyDrafts(questions)
  drafts.q1 = { values: ['main'], customText: '', note: '' }
  assert.equal(isFlowComplete(questions, drafts), true)
})

test('a required question is satisfied by a typed answer alone', () => {
  const questions = [single(true)]
  const drafts = emptyDrafts(questions)
  drafts.q1 = { values: [], customText: 'release/2.0', note: '' }
  assert.equal(isFlowComplete(questions, drafts), true)
})

test('an optional question left blank does not block submission', () => {
  const questions = [single(true, 'q1'), multi(false, 'q2')]
  const drafts = emptyDrafts(questions)
  drafts.q1 = { values: ['main'], customText: '', note: '' }
  assert.equal(isFlowComplete(questions, drafts), true)
})

test('whitespace is not an answer', () => {
  const questions = [single(true)]
  const drafts = emptyDrafts(questions)
  drafts.q1 = { values: [], customText: '   ', note: '' }
  assert.equal(isFlowComplete(questions, drafts), false)
})

test('a multi question keeps every selection instead of replacing', () => {
  assert.equal(isMultiQuestion(multi(true)), true)
  assert.equal(isMultiQuestion(single(true)), false)
})

test('the presented type wins over the requested type', () => {
  // pi-ask may present a downgraded type when policy or terminal size forbids
  // the original, and the renderer must match what the user is actually shown.
  const question: RelayAskQuestion = { ...single(true), type: 'preview', presentedType: 'multi' }
  assert.equal(effectiveQuestionType(question), 'multi')
})

test('empty fields are dropped rather than sent as empty strings', () => {
  const drafts: AskDraftMap = {
    q1: { values: ['main'], customText: '', note: '' },
    q2: { values: [], customText: 'extra', note: '  ' },
  }
  const answers = draftsToAnswers(drafts)
  assert.deepEqual(answers.q1, { values: ['main'] })
  assert.deepEqual(answers.q2, { customText: 'extra' })
  // A question answered with nothing at all is omitted entirely.
  assert.equal(Object.keys(draftsToAnswers({ q3: { values: [], customText: '', note: '' } })).length, 0)
})

test('a note alone counts as an answer and survives the conversion', () => {
  const drafts: AskDraftMap = { q1: { values: [], customText: '', note: 'needs review' } }
  assert.deepEqual(draftsToAnswers(drafts).q1, { note: 'needs review' })
  const questions = [single(true)]
  assert.equal(isFlowComplete(questions, drafts), true)
})
