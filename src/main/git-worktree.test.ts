import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  slugifyWorktreePart,
  worktreeBranchName,
  worktreeTargetPath,
} from './git-worktree'

test('slugifyWorktreePart produces safe readable path and branch segments', () => {
  assert.equal(slugifyWorktreePart('Feature: Add café tabs'), 'feature-add-cafe-tabs')
  assert.equal(slugifyWorktreePart('---'), 'tab')
})

test('worktree names are deterministic and isolated by workspace id', () => {
  assert.equal(
    worktreeBranchName('Pi Desktop', 'ws-123-abc'),
    'pi/pi-desktop-123-abc'
  )
  const target = worktreeTargetPath('/tmp/gui/worktrees', '/repo/My App', 'ws-123-abc')
  assert.match(target.replaceAll('\\', '/'), /\/tmp\/gui\/worktrees\/my-app\/my-app-ws-123-abc$/)
})
