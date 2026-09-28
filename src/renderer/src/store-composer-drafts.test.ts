import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Workspace } from '../../shared/ipc-contracts'
import { EMPTY_COMPOSER_DRAFT, useAppStore, type ComposerAttachment, type ComposerDraft } from './store'

function workspace(id: string): Workspace {
  return { id, name: id, path: `/tmp/${id}`, createdAt: 0, lastActiveAt: 0, color: '#000' }
}

function textDraft(text: string): ComposerDraft {
  return { text, attachments: [] }
}

const NOTES_ATTACHMENT: ComposerAttachment = { kind: 'text', name: 'notes.md', path: '/tmp/notes.md', content: '# Notes' }

beforeEach(() => {
  useAppStore.setState({
    composerDrafts: {},
    workspaces: [workspace('project-a'), workspace('project-b')],
  })
})

test('each project retains its own composer text across repeated edits', () => {
  const { saveComposerDraft } = useAppStore.getState()
  saveComposerDraft('project-a', textDraft('Draft A\nsecond line'))
  assert.equal(useAppStore.getState().composerDrafts['project-b'], undefined)

  saveComposerDraft('project-b', textDraft('Draft B'))
  assert.equal(useAppStore.getState().composerDrafts['project-a'].text, 'Draft A\nsecond line')

  saveComposerDraft('project-a', textDraft('Updated A'))
  assert.equal(useAppStore.getState().composerDrafts['project-b'].text, 'Draft B')
  assert.equal(useAppStore.getState().composerDrafts['project-a'].text, 'Updated A')
})

test('each project keeps its own staged attachments', () => {
  const { saveComposerDraft } = useAppStore.getState()
  saveComposerDraft('project-a', { text: '', attachments: [NOTES_ATTACHMENT] })
  saveComposerDraft('project-b', textDraft('Draft B'))

  assert.deepEqual(useAppStore.getState().composerDrafts['project-a'].attachments, [NOTES_ATTACHMENT])
  assert.deepEqual(useAppStore.getState().composerDrafts['project-b'].attachments, [])
})

test('leaving a sent or cleared composer removes only its own draft', () => {
  const { saveComposerDraft } = useAppStore.getState()
  saveComposerDraft('project-a', { text: 'Draft A', attachments: [NOTES_ATTACHMENT] })
  saveComposerDraft('project-b', textDraft('Draft B'))
  saveComposerDraft('project-a', EMPTY_COMPOSER_DRAFT)

  assert.equal('project-a' in useAppStore.getState().composerDrafts, false)
  assert.equal(useAppStore.getState().composerDrafts['project-b'].text, 'Draft B')
})

test('the composer without a project does not share a project draft', () => {
  const { saveComposerDraft } = useAppStore.getState()
  saveComposerDraft('', textDraft('No project'))
  saveComposerDraft('project-a', textDraft('Draft A'))
  saveComposerDraft('project-a', EMPTY_COMPOSER_DRAFT)

  assert.equal(useAppStore.getState().composerDrafts[''].text, 'No project')
})

test('a removed workspace keeps no draft when its composer saves late', () => {
  useAppStore.setState({ workspaces: [workspace('project-b')] })
  useAppStore.getState().saveComposerDraft('project-a', { text: 'Draft A', attachments: [NOTES_ATTACHMENT] })

  assert.equal('project-a' in useAppStore.getState().composerDrafts, false)
})
