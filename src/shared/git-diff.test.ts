import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canDiscardGitPatch, gitDiffPaths, splitGitDiff } from './git-diff'

const patch = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+  \n'

test('splits patches without trimming meaningful whitespace or changing content', () => {
  const second = patch.replaceAll('a.txt', 'b.txt')
  assert.deepEqual(splitGitDiff(patch + '\n' + second), [patch, second])
  assert.deepEqual(splitGitDiff(''), [])
  assert.deepEqual(gitDiffPaths(patch), { oldPath: 'a.txt', newPath: 'a.txt' })
})

test('refuses unsupported patches instead of treating them as plain text', () => {
  assert.equal(canDiscardGitPatch(patch), true)
  assert.equal(canDiscardGitPatch(patch + 'Binary files a/a.txt and b/a.txt differ\n'), false)
  assert.equal(canDiscardGitPatch(patch + 'new file mode 120000\n'), false)
  assert.equal(canDiscardGitPatch(patch + 'new file mode 160000\n'), false)
  assert.equal(canDiscardGitPatch(patch + '\0'), false)
  assert.equal(canDiscardGitPatch('diff --git "a/quoted\\npath" "b/quoted\\npath"\n'), false)
})
