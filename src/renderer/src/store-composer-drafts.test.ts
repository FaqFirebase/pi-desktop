import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { useAppStore } from './store'

beforeEach(() => {
  useAppStore.setState({ composerDrafts: {}, composerAttachmentDrafts: {} })
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

test('clearing sent attachments preserves another project and the outgoing image', () => {
  const { saveComposerAttachments } = useAppStore.getState()
  const attachments = [{
    kind: 'image' as const,
    name: 'image.png',
    path: '/project/image.png',
    image: { type: 'image' as const, mimeType: 'image/png', data: 'aW1hZ2U=' },
  }]
  saveComposerAttachments('project-a', attachments)
  saveComposerAttachments('project-b', attachments)

  const outgoing = useAppStore.getState().composerAttachmentDrafts['project-a']
  saveComposerAttachments('project-a', [])
  // A subsequent unmount also saves the now-empty composer.
  saveComposerAttachments('project-a', [])

  assert.equal(useAppStore.getState().composerAttachmentDrafts['project-a'], undefined)
  assert.deepEqual(useAppStore.getState().composerAttachmentDrafts['project-b'], attachments)
  assert.equal(outgoing.length, 1)
  assert.equal(outgoing[0].kind, 'image')
})

test('the composer without a project does not share a project draft', () => {
  const { saveComposerDraft } = useAppStore.getState()
  saveComposerDraft('', 'No project')
  saveComposerDraft('project-a', 'Draft A')
  saveComposerDraft('project-a', '')

  assert.equal(useAppStore.getState().composerDrafts[''], 'No project')
})
