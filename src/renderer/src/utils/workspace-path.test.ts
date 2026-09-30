import { test } from 'node:test'
import assert from 'node:assert/strict'
import { joinWorkspacePath, workspaceRelativeGitPath } from './workspace-path'

test('workspaceRelativeGitPath keeps paths unchanged at the repository root', () => {
  assert.equal(workspaceRelativeGitPath('src/a.ts', ''), 'src/a.ts')
})

test('workspaceRelativeGitPath strips the subfolder prefix and rejects paths outside it', () => {
  assert.equal(workspaceRelativeGitPath('pkg/app/src/a.ts', 'pkg/app/'), 'src/a.ts')
  assert.equal(workspaceRelativeGitPath('root.ts', 'pkg/app/'), null)
  assert.equal(workspaceRelativeGitPath('pkg/other/a.ts', 'pkg/app/'), null)
})

test('workspaceRelativeGitPath matches whole directory names only', () => {
  assert.equal(workspaceRelativeGitPath('pkg/app2/a.ts', 'pkg/app/'), null)
  assert.equal(workspaceRelativeGitPath('pkg/app2/a.ts', 'pkg/app'), null)
  assert.equal(workspaceRelativeGitPath('pkg/app/a.ts', 'pkg/app'), 'a.ts')
})

test('workspaceRelativeGitPath accepts Windows separators', () => {
  assert.equal(workspaceRelativeGitPath('pkg\\app\\src\\a.ts', 'pkg\\app\\'), 'src/a.ts')
  assert.equal(workspaceRelativeGitPath('pkg/app2/a.ts', 'pkg\\app\\'), null)
})

test('joinWorkspacePath follows the workspace separator style', () => {
  assert.equal(joinWorkspacePath('/project', 'src/new name.ts'), '/project/src/new name.ts')
  assert.equal(joinWorkspacePath('/project/', 'a.ts'), '/project/a.ts')
  assert.equal(joinWorkspacePath('C:\\project\\', 'assets/image.png'), 'C:\\project\\assets\\image.png')
})
