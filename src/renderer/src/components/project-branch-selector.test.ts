import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import type { GitConveyorStatus } from '../../../shared/ipc-contracts'
import { useAppStore } from '../store'
import { withGitOperation } from '../utils/git-operation'
import { switchProjectBranch } from './project-branch-selector'

const status: GitConveyorStatus = {
  branch: 'main', head: 'head', lastCommitMessage: 'Previous commit',
  dirtyFiles: 0, ahead: 0, behind: 0, hasUpstream: true,
  pushRemote: 'origin', upstreamBranch: 'main', baseBranch: 'main', remoteUrl: null,
}
let calls: string[]

beforeEach(() => {
  calls = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { piDesktop: {
      ui: { setEditorDirty: () => {} },
      git: {
        switchBranch: async (workspaceId: string, branch: string) => {
          calls.push(`switch:${workspaceId}:${branch}`)
          return { ...status, branch }
        },
      },
    } },
  })
  useAppStore.setState({
    activeWorkspace: {
      id: 'project', name: 'Project', path: '/project',
      createdAt: 0, lastActiveAt: 0, color: '',
    },
    editorDirty: false,
    previewTarget: null,
  })
})

test('switching branches closes a clean preview before changing the explicitly bound workspace', async (context) => {
  useAppStore.setState({ previewTarget: { kind: 'code', path: '/project/app.ts', name: 'app.ts', relativePath: 'app.ts' } })
  context.mock.method(useAppStore.getState(), 'setPreviewTarget', async (target: unknown) => {
    assert.equal(target, null)
    calls.push('close-preview')
    return true
  })
  assert.equal((await switchProjectBranch('project', 'feature/next'))?.branch, 'feature/next')
  assert.deepEqual(calls, ['close-preview', 'switch:project:feature/next'])
})

test('switching branches refuses unsaved editor changes and a changed workspace', async () => {
  useAppStore.setState({ editorDirty: true })
  await assert.rejects(switchProjectBranch('project', 'other'), /Save or revert/)
  useAppStore.setState({ editorDirty: false })
  await assert.rejects(switchProjectBranch('previous-workspace', 'other'), /workspace changed/)
  assert.deepEqual(calls, [])
})

for (const scenario of ['cancel', 'workspace', 'editor']) {
  test(`switching branches rechecks the workspace and editor after closing a preview: ${scenario}`, async (context) => {
    useAppStore.setState({ previewTarget: { kind: 'code', path: '/project/app.ts', name: 'app.ts', relativePath: 'app.ts' } })
    context.mock.method(useAppStore.getState(), 'setPreviewTarget', async () => {
      if (scenario === 'workspace') useAppStore.setState({ activeWorkspace: null })
      if (scenario === 'editor') useAppStore.setState({ editorDirty: true })
      return scenario !== 'cancel'
    })
    if (scenario === 'cancel') assert.equal(await switchProjectBranch('project', 'other'), null)
    else await assert.rejects(switchProjectBranch('project', 'other'))
    assert.deepEqual(calls, [])
  })
}

test('a rejected branch switch surfaces the Git error without retrying and releases the operation guard', async () => {
  const switchBranch = window.piDesktop.git.switchBranch
  window.piDesktop.git.switchBranch = async () => { throw new Error('local changes would be overwritten') }
  await assert.rejects(switchProjectBranch('project', 'other'), /overwritten/)
  assert.deepEqual(calls, [])
  window.piDesktop.git.switchBranch = switchBranch
  assert.equal((await switchProjectBranch('project', 'other'))?.branch, 'other')
})

test('a commit/push already in flight prevents branch switching until it finishes', async () => {
  let finish!: () => void
  const pending = withGitOperation(() => new Promise<void>((resolve) => { finish = resolve }))
  try {
    await assert.rejects(switchProjectBranch('project', 'other'), /Git operation is in progress/)
    assert.deepEqual(calls, [])
  } finally {
    finish()
    await pending
  }
  await switchProjectBranch('project', 'other')
  assert.deepEqual(calls, ['switch:project:other'])
})

test('a branch switch in flight prevents a second Git mutation from starting', async () => {
  let finish!: (value: GitConveyorStatus) => void
  window.piDesktop.git.switchBranch = () => new Promise((resolve) => { finish = resolve })
  const pending = switchProjectBranch('project', 'other')
  let started = false
  try {
    await assert.rejects(withGitOperation(async () => { started = true }), /Git operation is in progress/)
    assert.equal(started, false)
  } finally {
    finish({ ...status, branch: 'other' })
    await pending
  }
  await withGitOperation(async () => { started = true })
  assert.equal(started, true)
})
