import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { isImeComposing } from '../utils/ime-composing'
import type { GitConveyorStatus, GitFileStatus } from '../../../shared/ipc-contracts'
import { GIT_CONVEYOR_NOTICE_TIMEOUT_MS } from '../../../shared/default-settings'
import { useAppStore } from '../store'
import { commitConveyorChanges, gitPublishAction, gitStatusErrorReducer, scheduleGitNoticeDismissal } from './git-conveyor-actions'

function commitKeyHandler(): string {
  const source = ts.createSourceFile(
    'git-conveyor-actions.tsx',
    readFileSync(new URL('./git-conveyor-actions.tsx', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX,
  )
  let handler: string | undefined
  function visit(node: ts.Node): void {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'textarea') {
      for (const attribute of node.attributes.properties) {
        if (ts.isJsxAttribute(attribute) && attribute.name.getText(source) === 'onKeyDown' &&
            attribute.initializer && ts.isJsxExpression(attribute.initializer)) {
          handler = attribute.initializer.expression?.getText(source)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(handler, 'The commit message must handle keyboard submission')
  return handler
}

for (const scenario of [
  { name: 'Command+Enter submits', key: 'Enter', metaKey: true, submits: true },
  { name: 'Ctrl+Enter submits', key: 'Enter', ctrlKey: true, submits: true },
  { name: 'Enter preserves newlines', key: 'Enter', submits: false },
  { name: 'Shift+Enter preserves newlines', key: 'Enter', shiftKey: true, submits: false },
  { name: 'other keys do not submit', key: 'a', metaKey: true, submits: false },
  { name: 'IME confirmation does not submit', key: 'Enter', metaKey: true, nativeEvent: { isComposing: true }, submits: false },
  { name: 'IME processing does not submit', key: 'Enter', metaKey: true, nativeEvent: { keyCode: 229 }, submits: false },
]) {
  test(`commit message: ${scenario.name}`, () => {
    let submissions = 0
    let prevented = false
    let stopped = false
    const handler = new Function('isImeComposing', `return (${commitKeyHandler()})`)(isImeComposing)
    handler({
      nativeEvent: {},
      ...scenario,
      currentTarget: { form: { requestSubmit: () => { submissions++ } } },
      preventDefault: () => { prevented = true },
      stopPropagation: () => { stopped = true },
    })
    assert.equal(submissions, scenario.submits ? 1 : 0)
    assert.equal(prevented, scenario.submits)
    assert.equal(stopped, scenario.submits)
  })
}

const dirtyStatus: GitConveyorStatus = {
  branch: 'feature', head: 'old-head', lastCommitMessage: 'Previous commit',
  dirtyFiles: 1, ahead: 0, behind: 0, hasUpstream: true,
  pushRemote: 'origin', upstreamBranch: 'feature', baseBranch: 'main', remoteUrl: null,
}
const committedStatus = { ...dirtyStatus, head: '1234567890abcdef', dirtyFiles: 0, ahead: 1 }
const pushedStatus = { ...committedStatus, ahead: 0 }
let calls: string[]

beforeEach(() => {
  calls = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { piDesktop: { git: {
      commit: async ({ message, paths }: { message: string; paths?: string[] }) => {
        calls.push(paths ? `commit:${message}:${paths.join(',')}` : `commit:${message}`)
        return committedStatus
      },
      push: async () => {
        calls.push('push')
        return pushedStatus
      },
      generateCommitMessage: async ({ paths }: { paths?: string[] }) => {
        calls.push(paths ? `generate:${paths.join(',')}` : 'generate')
        return { message: 'Generated message', error: null }
      },
    } } },
  })
  useAppStore.setState({
    activeWorkspace: {
      id: 'project', name: 'Project', path: '/project',
      createdAt: 0, lastActiveAt: 0, color: '',
    },
    confirmRequest: null,
  })
})

const unpushed: GitConveyorStatus = { ...dirtyStatus, branch: 'feature', ahead: 1, hasUpstream: true }

test('Commit + Push follows current changes, then switches to Push after committing them', () => {
  const files: Record<string, GitFileStatus> = {
    'app.ts': { index: ' ', worktree: 'M', isStaged: false },
    'notes.md': { index: '?', worktree: '?', isStaged: false },
  }
  assert.equal(gitPublishAction(files, unpushed), 'commitPush')
  delete files['app.ts']
  assert.equal(gitPublishAction(files, unpushed), 'push')
  files['app.ts'] = { index: ' ', worktree: 'M', isStaged: false }
  assert.equal(gitPublishAction(files, unpushed), 'commitPush')
})

test('staging a new file enables Commit + Push without requiring tracked modifications', () => {
  assert.equal(gitPublishAction({ 'new.ts': { index: '?', worktree: '?', isStaged: false } }, unpushed), 'push')
  assert.equal(gitPublishAction({ 'new.ts': { index: 'A', worktree: ' ', isStaged: true } }, unpushed), 'commitPush')
})

test('tracked deletions, type changes and staged renames still need a commit', () => {
  for (const worktree of ['D', 'T']) {
    assert.equal(gitPublishAction({ 'app.ts': { index: ' ', worktree, isStaged: false } }, unpushed), 'commitPush')
  }
  assert.equal(gitPublishAction({ 'renamed.ts': { index: 'R', worktree: ' ', isStaged: true } }, unpushed), 'commitPush')
})

test('a selection offers Commit for the files on screen, untracked ones included, and ignores the rest of the tree', () => {
  const untracked: Record<string, GitFileStatus> = { 'new.ts': { index: '?', worktree: '?', isStaged: false } }
  assert.equal(gitPublishAction(untracked, unpushed, { files: 1, paths: ['new.ts'] }), 'commitPush')
  assert.equal(gitPublishAction(untracked, unpushed, { files: 0, paths: [] }), 'push')
  const staged: Record<string, GitFileStatus> = { 'app.ts': { index: 'M', worktree: ' ', isStaged: true } }
  assert.equal(gitPublishAction(staged, unpushed, { files: 0, paths: [] }), 'push')
})

test('an empty filter never offers Commit for hidden changes; removing it enables Commit', () => {
  const tracked: Record<string, GitFileStatus> = { 'app.ts': { index: ' ', worktree: 'M', isStaged: false } }
  const empty = { files: 0, paths: [] }
  assert.equal(gitPublishAction(tracked, dirtyStatus, empty), null)
  assert.equal(gitPublishAction(tracked, unpushed, empty), 'push')
  assert.equal(gitPublishAction(tracked, dirtyStatus), 'commitPush')
})

test('Push is offered only while the branch has commits the remote lacks', () => {
  const clean = { ...unpushed, ahead: 0, hasUpstream: true }
  assert.equal(gitPublishAction({}, clean), null)
  assert.equal(gitPublishAction({}, clean, { files: 0, paths: [] }), null)
  assert.equal(gitPublishAction({}, { ...clean, ahead: 2 }), 'push')
  assert.equal(gitPublishAction({}, { ...clean, hasUpstream: false }), 'push')
  assert.equal(gitPublishAction({}, { ...clean, branch: null, hasUpstream: false }), null)
  assert.equal(gitPublishAction({}, null), null)
})

test('commit sends the filtered selection only when there is one', async () => {
  await commitConveyorChanges('Fix bug', false, ['src/a.ts', 'src/new.ts'])
  await commitConveyorChanges('Fix all', false)
  assert.deepEqual(calls, ['commit:Fix bug:src/a.ts,src/new.ts', 'commit:Fix all'])
})

test('an empty message commits with the generated one for the same files', async () => {
  await commitConveyorChanges('', true, ['src/a.ts'])
  await commitConveyorChanges('', false)
  assert.deepEqual(calls, ['generate:src/a.ts', 'commit:Generated message:src/a.ts', 'push', 'generate', 'commit:Generated message'])
})

test('a failed generation or a workspace switch during it never commits', async () => {
  window.piDesktop.git.generateCommitMessage = async () => ({ message: null, error: 'timed-out' })
  await assert.rejects(commitConveyorChanges('', false), /timed out/)
  window.piDesktop.git.generateCommitMessage = async () => {
    useAppStore.setState({ activeWorkspace: { ...useAppStore.getState().activeWorkspace!, id: 'other' } })
    return { message: 'Generated message', error: null }
  }
  await assert.rejects(commitConveyorChanges('', false), /workspace changed/)
  assert.deepEqual(calls, [])
})

test('a clean tree or only ignored files selects Push', () => {
  assert.equal(gitPublishAction({}, unpushed), 'push')
  assert.equal(gitPublishAction({ 'build/': { index: '!', worktree: '!', isStaged: false } }, unpushed), 'push')
})

test('dismissed status errors stay dismissed across repeated polling failures', () => {
  const failed = gitStatusErrorReducer(null, { type: 'failed', message: 'Git unavailable' })
  assert.deepEqual(failed, { message: 'Git unavailable', dismissed: false })
  const dismissed = gitStatusErrorReducer(failed, { type: 'dismiss' })
  assert.equal(dismissed?.dismissed, true)
  assert.equal(gitStatusErrorReducer(dismissed, { type: 'failed', message: 'Git unavailable' }), dismissed)
})

test('a different status error or a failure after recovery is visible again', () => {
  const dismissed = { message: 'Git unavailable', dismissed: true }
  assert.deepEqual(gitStatusErrorReducer(dismissed, { type: 'failed', message: 'Permission denied' }), {
    message: 'Permission denied', dismissed: false,
  })
  const recovered = gitStatusErrorReducer(dismissed, { type: 'recovered' })
  assert.equal(recovered, null)
  assert.deepEqual(gitStatusErrorReducer(recovered, { type: 'failed', message: 'Git unavailable' }), {
    message: 'Git unavailable', dismissed: false,
  })
  assert.equal(gitStatusErrorReducer(null, { type: 'dismiss' }), null)
})

test('success notices dismiss automatically once their display time expires', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let dismissed = 0
  scheduleGitNoticeDismissal('success', () => { dismissed += 1 })
  context.mock.timers.tick(GIT_CONVEYOR_NOTICE_TIMEOUT_MS.success - 1)
  assert.equal(dismissed, 0)
  context.mock.timers.tick(1)
  assert.equal(dismissed, 1)
  context.mock.timers.tick(GIT_CONVEYOR_NOTICE_TIMEOUT_MS.success)
  assert.equal(dismissed, 1)
})

test('automatically dismissed status errors do not reappear on the next poll', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let state = gitStatusErrorReducer(null, { type: 'failed', message: 'Git unavailable' })
  scheduleGitNoticeDismissal('error', () => { state = gitStatusErrorReducer(state, { type: 'dismiss' }) })
  context.mock.timers.tick(GIT_CONVEYOR_NOTICE_TIMEOUT_MS.error - 1)
  assert.equal(state?.dismissed, false)
  context.mock.timers.tick(1)
  assert.equal(state?.dismissed, true)
  state = gitStatusErrorReducer(state, { type: 'failed', message: 'Git unavailable' })
  assert.equal(state?.dismissed, true)
})

test('closing, replacing or unmounting a notice cancels its pending dismissal', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const dismissed: string[] = []
  const cancelOld = scheduleGitNoticeDismissal('success', () => { dismissed.push('old') })
  context.mock.timers.tick(GIT_CONVEYOR_NOTICE_TIMEOUT_MS.success - 1)
  cancelOld()
  const cancelNew = scheduleGitNoticeDismissal('error', () => { dismissed.push('new') })
  context.mock.timers.tick(1)
  assert.deepEqual(dismissed, [])
  cancelNew()
  context.mock.timers.tick(GIT_CONVEYOR_NOTICE_TIMEOUT_MS.error)
  assert.deepEqual(dismissed, [])
})

test('commit alone neither requests push confirmation nor pushes', async () => {
  assert.equal(await commitConveyorChanges('Fix bug', false), committedStatus)
  assert.deepEqual(calls, ['commit:Fix bug'])
  assert.equal(useAppStore.getState().confirmRequest, null)
})

test('commit + push waits for the commit without opening another confirmation', async () => {
  let finishCommit!: (status: GitConveyorStatus) => void
  const committed = new Promise<GitConveyorStatus>((resolve) => { finishCommit = resolve })
  window.piDesktop.git.commit = async () => {
    calls.push('commit')
    return committed
  }
  const result = commitConveyorChanges('Fix bug', true)
  assert.equal(useAppStore.getState().confirmRequest, null)
  assert.deepEqual(calls, ['commit'])
  finishCommit(committedStatus)
  assert.equal(await result, pushedStatus)
  assert.deepEqual(calls, ['commit', 'push'])
  assert.equal(useAppStore.getState().confirmRequest, null)
})

test('commit + push still pushes when the commit leaves unrelated local changes', async () => {
  window.piDesktop.git.commit = async () => {
    calls.push('commit')
    return { ...committedStatus, dirtyFiles: 2 }
  }
  window.piDesktop.git.push = async () => {
    calls.push('push')
    return { ...pushedStatus, dirtyFiles: 2 }
  }
  const result = await commitConveyorChanges('Fix bug', true)
  assert.equal(result.dirtyFiles, 2)
  assert.equal(result.ahead, 0)
  assert.deepEqual(calls, ['commit', 'push'])
  assert.equal(useAppStore.getState().confirmRequest, null)
})

test('a failed commit never attempts push', async () => {
  window.piDesktop.git.commit = async () => { throw new Error('commit rejected') }
  const result = commitConveyorChanges('Fix bug', true)
  await assert.rejects(result, /commit rejected/)
  assert.deepEqual(calls, [])
})

test('a failed push reports the successful local commit without committing again', async () => {
  window.piDesktop.git.push = async () => {
    calls.push('push')
    throw new Error('remote rejected')
  }
  const result = commitConveyorChanges('Fix bug', true)
  await assert.rejects(result, /Commit 12345678 was saved locally.*remote rejected/)
  assert.deepEqual(calls, ['commit:Fix bug', 'push'])
})

test('a missing workspace prevents both operations', async () => {
  useAppStore.setState({ activeWorkspace: null })
  await assert.rejects(commitConveyorChanges('Fix bug', true), /workspace changed/)
  assert.deepEqual(calls, [])
})

test('switching workspace during commit never pushes the newly active workspace', async () => {
  window.piDesktop.git.commit = async () => {
    calls.push('commit')
    useAppStore.setState({ activeWorkspace: { ...useAppStore.getState().activeWorkspace!, id: 'other' } })
    return committedStatus
  }
  const result = commitConveyorChanges('Fix bug', true)
  await assert.rejects(result, /Commit 12345678 was saved locally.*workspace changed/)
  assert.deepEqual(calls, ['commit'])
})
