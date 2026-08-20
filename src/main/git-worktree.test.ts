import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  parseGitWorktrees,
  slugifyWorktreePart,
  worktreeBranchName,
  worktreeTargetPath,
} from './git-worktree'

test('slugifyWorktreePart produces safe readable path and branch segments', () => {
  assert.equal(slugifyWorktreePart('Feature: Add café tabs'), 'feature-add-cafe-tabs')
  assert.equal(slugifyWorktreePart('---'), 'tab')
})

test('parseGitWorktrees preserves paths, branches, and bare markers', () => {
  assert.deepEqual(parseGitWorktrees([
    'worktree E:\\repo\\main app',
    'HEAD abc123',
    'branch refs/heads/main',
    '',
    'worktree E:\\repo\\bare',
    'bare',
    '',
  ].join('\n')), [
    { path: 'E:\\repo\\main app', head: 'abc123', branch: 'main', bare: false },
    { path: 'E:\\repo\\bare', head: null, branch: null, bare: true },
  ])
})

test('worktree names are deterministic and isolated by workspace id', () => {
  assert.equal(
    worktreeBranchName('Pi Desktop', 'ws-123-abc'),
    'pi/pi-desktop-123-abc'
  )
  const target = worktreeTargetPath('/tmp/gui/worktrees', '/repo/My App', 'ws-123-abc')
  assert.match(target.replaceAll('\\', '/'), /\/tmp\/gui\/worktrees\/my-app\/my-app-ws-123-abc$/)
})
