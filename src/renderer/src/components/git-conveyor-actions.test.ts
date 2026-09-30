import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { isImeComposing } from '../utils/ime-composing'
import type { GitConveyorStatus, GitFileStatus } from '../../../shared/ipc-contracts'
import { GIT_CONVEYOR_NOTICE_TIMEOUT_MS } from '../../../shared/default-settings'
import { useAppStore } from '../store'
import {
  commitConveyorChanges, gitPublishAction, gitStatusErrorReducer, scheduleGitNoticeDismissal,
} from './git-conveyor-actions'

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
  pushRemote: 'origin', upstreamBranch: 'feature',
  baseBranch: 'main', remoteUrl: 'https://github.com/example/repo.git',
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
        calls.push([`commit:${message}`, ...(paths ? [paths.join(',')] : [])].join(':'))
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
const unpushedClean: GitConveyorStatus = { ...unpushed, dirtyFiles: 0 }

/** Answers the next push confirmation and records that it was asked. */
function answerPushConfirmation(confirmed: boolean): void {
  const unsubscribe = useAppStore.subscribe((state) => {
    if (!state.confirmRequest) return
    unsubscribe()
    calls.push(`confirm:${state.confirmRequest.title}`)
    state.resolveConfirm(confirmed)
  })
}

test('Commit + Push follows current changes, then Push once the working tree is clean', () => {
  const files: Record<string, GitFileStatus> = {
    'app.ts': { index: ' ', worktree: 'M', isStaged: false },
    'notes.md': { index: '?', worktree: '?', isStaged: false },
  }
  assert.equal(gitPublishAction(files, unpushed), 'commitPush')
  delete files['app.ts']
  assert.equal(gitPublishAction(files, unpushed), null)
  assert.equal(gitPublishAction({}, unpushedClean), 'push')
})

test('an untracked file alone offers no Commit until the user stages it', () => {
  assert.equal(gitPublishAction({ 'new.ts': { index: '?', worktree: '?', isStaged: false } }, unpushed), null)
  assert.equal(gitPublishAction({ 'new.ts': { index: 'A', worktree: ' ', isStaged: true } }, unpushed), 'commitPush')
})

test('tracked deletions, type changes and staged renames still need a commit', () => {
  for (const worktree of ['D', 'T']) {
    assert.equal(gitPublishAction({ 'app.ts': { index: ' ', worktree, isStaged: false } }, unpushed), 'commitPush')
  }
  assert.equal(gitPublishAction({ 'renamed.ts': { index: 'R', worktree: ' ', isStaged: true } }, unpushed), 'commitPush')
})

test('a selection offers Commit only for tracked or staged files on screen and ignores the rest of the tree', () => {
  const files: Record<string, GitFileStatus> = {
    'app.ts': { index: ' ', worktree: 'M', isStaged: false },
    'new.ts': { index: '?', worktree: '?', isStaged: false },
    'added.ts': { index: 'A', worktree: ' ', isStaged: true },
  }
  assert.equal(gitPublishAction(files, unpushed, { files: 1, paths: ['app.ts'] }), 'commitPush')
  assert.equal(gitPublishAction(files, unpushed, { files: 1, paths: ['added.ts'] }), 'commitPush')
  assert.equal(gitPublishAction(files, unpushed, { files: 1, paths: ['new.ts'] }), null)
  assert.equal(gitPublishAction(files, unpushed, { files: 0, paths: [] }), null)
})

test('an empty filter never offers Commit for hidden changes; removing it enables Commit', () => {
  const tracked: Record<string, GitFileStatus> = { 'app.ts': { index: ' ', worktree: 'M', isStaged: false } }
  assert.equal(gitPublishAction(tracked, dirtyStatus, { files: 0, paths: [] }), null)
  assert.equal(gitPublishAction(tracked, dirtyStatus), 'commitPush')
})

test('Push is offered only while the branch has commits the remote lacks and the tree is clean', () => {
  const clean = { ...unpushedClean, ahead: 0, hasUpstream: true }
  assert.equal(gitPublishAction({}, clean), null)
  assert.equal(gitPublishAction({}, clean, { files: 0, paths: [] }), null)
  assert.equal(gitPublishAction({}, { ...clean, ahead: 2 }), 'push')
  assert.equal(gitPublishAction({}, { ...clean, hasUpstream: false }), 'push')
  assert.equal(gitPublishAction({}, { ...clean, ahead: 2, dirtyFiles: 3 }), null)
  assert.equal(gitPublishAction({}, { ...clean, branch: null, hasUpstream: false }), null)
  assert.equal(gitPublishAction({}, null), null)
})

test('commit sends the filtered selection only when there is one', async () => {
  await commitConveyorChanges('Fix bug', false, ['src/a.ts', 'src/new.ts'])
  await commitConveyorChanges('Fix all', false)
  assert.deepEqual(calls, ['commit:Fix bug:src/a.ts,src/new.ts', 'commit:Fix all'])
})

test('an empty message is refused and never sends the changes to the model', async () => {
  await assert.rejects(commitConveyorChanges('', false), /Commit message is required/)
  await assert.rejects(commitConveyorChanges('   ', true, ['src/a.ts']), /Commit message is required/)
  assert.deepEqual(calls, [])
})

test('a clean tree or only ignored files selects Push', () => {
  assert.equal(gitPublishAction({}, unpushedClean), 'push')
  assert.equal(gitPublishAction({ 'build/': { index: '!', worktree: '!', isStaged: false } }, unpushedClean), 'push')
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
  assert.deepEqual(await commitConveyorChanges('Fix bug', false), { status: committedStatus, pushed: false })
  assert.deepEqual(calls, ['commit:Fix bug'])
  assert.equal(useAppStore.getState().confirmRequest, null)
})

test('commit + push asks the push confirmation only after the commit, then pushes', async () => {
  let finishCommit!: (status: GitConveyorStatus) => void
  const committed = new Promise<GitConveyorStatus>((resolve) => { finishCommit = resolve })
  window.piDesktop.git.commit = async () => {
    calls.push('commit')
    return committed
  }
  const result = commitConveyorChanges('Fix bug', true)
  assert.equal(useAppStore.getState().confirmRequest, null)
  assert.deepEqual(calls, ['commit'])
  answerPushConfirmation(true)
  finishCommit(committedStatus)
  assert.deepEqual(await result, { status: pushedStatus, pushed: true })
  assert.deepEqual(calls, ['commit', 'confirm:Push branch?', 'push'])
  assert.equal(useAppStore.getState().confirmRequest, null)
})

test('declining the push confirmation keeps the commit and never pushes', async () => {
  answerPushConfirmation(false)
  assert.deepEqual(await commitConveyorChanges('Fix bug', true), { status: committedStatus, pushed: false })
  assert.deepEqual(calls, ['commit:Fix bug', 'confirm:Push branch?'])
})

test('commit + push never pushes while changes remain after the commit', async () => {
  window.piDesktop.git.commit = async () => {
    calls.push('commit')
    return { ...committedStatus, dirtyFiles: 2 }
  }
  await assert.rejects(
    commitConveyorChanges('Fix bug', true, ['src/a.ts']),
    /Commit 12345678 was saved locally.*Commit the working tree before pushing/,
  )
  assert.deepEqual(calls, ['commit'])
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
  answerPushConfirmation(true)
  const result = commitConveyorChanges('Fix bug', true)
  await assert.rejects(result, /Commit 12345678 was saved locally.*remote rejected/)
  assert.deepEqual(calls, ['commit:Fix bug', 'confirm:Push branch?', 'push'])
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
  assert.equal(useAppStore.getState().confirmRequest, null)
})

test('the action bar follows the same refresh triggers as the diff list', () => {
  const source = readFileSync(new URL('./git-conveyor-actions.tsx', import.meta.url), 'utf8')
  assert.match(source, /useEffect\(\(\) => subscribeWorktreeRefresh\(refresh, watchDisk\), \[refresh, watchDisk\]\)/)
  const diffViewer = readFileSync(new URL('./diff-viewer.tsx', import.meta.url), 'utf8')
  assert.match(diffViewer, /<GitConveyorActions [^>]*watchDisk=\{visible\}/)
})
