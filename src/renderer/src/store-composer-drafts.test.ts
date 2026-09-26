import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { useAppStore } from './store'

beforeEach(() => {
  useAppStore.setState({ composerDrafts: {} })
})

test('each project retains its own composer text across repeated edits', () => {
  const { saveComposerDraft } = useAppStore.getState()
  saveComposerDraft('project-a', 'Draft A\nsecond line')
  assert.equal(useAppStore.getState().composerDrafts['project-b'] ?? '', '')

  saveComposerDraft('project-b', 'Draft B')
  assert.equal(useAppStore.getState().composerDrafts['project-a'], 'Draft A\nsecond line')

  saveComposerDraft('project-a', 'Updated A')
  assert.equal(useAppStore.getState().composerDrafts['project-b'], 'Draft B')
  assert.equal(useAppStore.getState().composerDrafts['project-a'], 'Updated A')
})

test('leaving a sent or cleared composer removes only its own draft', () => {
  const { saveComposerDraft } = useAppStore.getState()
  saveComposerDraft('project-a', 'Draft A')
  saveComposerDraft('project-b', 'Draft B')
  saveComposerDraft('project-a', '')

  assert.equal(useAppStore.getState().composerDrafts['project-a'] ?? '', '')
  assert.equal(useAppStore.getState().composerDrafts['project-b'], 'Draft B')
})

test('the composer without a project does not share a project draft', () => {
  const { saveComposerDraft } = useAppStore.getState()
  saveComposerDraft('', 'No project')
  saveComposerDraft('project-a', 'Draft A')
  saveComposerDraft('project-a', '')

  assert.equal(useAppStore.getState().composerDrafts[''], 'No project')
})
