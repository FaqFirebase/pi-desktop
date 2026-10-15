import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import {
  describeGitFailure,
  GIT_FATAL_EXIT_CODE,
  GitCommandError,
  isMissingRepositoryError,
  parseGitWorktrees,
  runGit,
  slugifyWorktreePart,
  worktreeBranchName,
  worktreeTargetPath,
} from './git-worktree'
import { i18n, tEnglish } from '../shared/i18n'
import { PSEUDO_LANGUAGE, SOURCE_LANGUAGE } from '../shared/i18n/languages'

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

test('runGit rejects with the exit code and streams of the failed command', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'pi-git-worktree-'))
  try {
    await assert.rejects(
      () => runGit(['rev-parse', '--show-toplevel'], folder),
      (error: unknown) => {
        assert.ok(error instanceof GitCommandError)
        assert.equal(error.exitCode, GIT_FATAL_EXIT_CODE)
        assert.match(error.stderr, /not a git repository/i)
        assert.match(error.message, /^git rev-parse --show-toplevel failed: fatal:/)
        assert.equal(isMissingRepositoryError(error), true)
        return true
      }
    )
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

/** Three-byte characters, enough of them to span several pipe reads. */
const MULTI_BYTE_TEXT = '€'.repeat(100_000)

test('runGit keeps characters whose bytes arrive in different output chunks', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'pi-git-worktree-'))
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: folder }).status, 0)
    await writeFile(join(folder, 'euro.txt'), MULTI_BYTE_TEXT, 'utf8')
    const blob = spawnSync('git', ['hash-object', '-w', 'euro.txt'], { cwd: folder, encoding: 'utf8' }).stdout.trim()
    assert.equal((await runGit(['cat-file', 'blob', blob], folder)).stdout, MULTI_BYTE_TEXT)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test('isMissingRepositoryError classifies only repository discovery failures', () => {
  const args = ['rev-parse', '--show-toplevel']
  assert.equal(
    isMissingRepositoryError(new GitCommandError(args, GIT_FATAL_EXIT_CODE, '', 'fatal: this operation must be run in a work tree\n')),
    true
  )
  assert.equal(
    isMissingRepositoryError(new GitCommandError(args, GIT_FATAL_EXIT_CODE, '', 'fatal: Needed a single revision\n')),
    false
  )
  assert.equal(
    isMissingRepositoryError(new GitCommandError(args, 1, '', 'fatal: not a git repository\n')),
    false
  )
  assert.equal(isMissingRepositoryError(new Error('spawn git ENOENT')), false)
})

test('describeGitFailure renders English for the log and marked text for the UI', async () => {
  const args = ['worktree', 'remove', '/repo/worktrees/x']
  await i18n.changeLanguage(PSEUDO_LANGUAGE)
  try {
    assert.equal(
      describeGitFailure(args, '', 'fatal: worktree is dirty\n', tEnglish),
      'git worktree remove /repo/worktrees/x failed: fatal: worktree is dirty',
    )
    // Only the app's own words are marked; the command and Git's text are not.
    assert.match(
      describeGitFailure(args, '', 'fatal: worktree is dirty\n'),
      /^\[git worktree remove \/repo\/worktrees\/x ƒáîļéð: fatal: worktree is dirty ~+\]$/,
    )
  } finally {
    await i18n.changeLanguage(SOURCE_LANGUAGE)
  }
})

test('worktree names are deterministic and isolated by workspace id', () => {
  assert.equal(
    worktreeBranchName('Pi Desktop', 'ws-123-abc'),
    'pi/pi-desktop-123-abc'
  )
  const target = worktreeTargetPath('/tmp/gui/worktrees', '/repo/My App', 'ws-123-abc')
  assert.match(target.replaceAll('\\', '/'), /\/tmp\/gui\/worktrees\/my-app\/my-app-ws-123-abc$/)
})
