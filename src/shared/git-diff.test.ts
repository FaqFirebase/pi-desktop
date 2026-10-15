import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canDiscardGitPatch, gitDiffPaths, quoteGitPath, splitGitDiff } from './git-diff'

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
})

// Headers exactly as git 2.53 prints them with the default core.quotePath.
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff)
const header = (names: string, ...extended: string[]): string => [`diff --git ${names}`, ...extended, ''].join('\n')

test('reads every unusual name Git quotes or leaves bare as its raw repository path', () => {
  for (const [names, path] of [
    ['a/Meeting notes.md b/Meeting notes.md', 'Meeting notes.md'],
    ['a/x b/y.txt b/x b/y.txt', 'x b/y.txt'],
    ['a/ lead and trail  b/ lead and trail ', ' lead and trail '],
    ['"a/gr\\303\\274\\303\\237e.txt" "b/gr\\303\\274\\303\\237e.txt"', 'grüße.txt'],
    ['"a/say \\"hi\\".txt" "b/say \\"hi\\".txt"', 'say "hi".txt'],
    ['"a/back\\\\slash.txt" "b/back\\\\slash.txt"', 'back\\slash.txt'],
    ['"a/tab\\there.txt" "b/tab\\there.txt"', 'tab\there.txt'],
    ['"a/new\\nline.txt" "b/new\\nline.txt"', 'new\nline.txt'],
    ['"a/bell\\a\\001.txt" "b/bell\\a\\001.txt"', 'bell\u0007\u0001.txt'],
    // core.quotePath=false keeps non-ASCII letters as they are inside the quotes.
    ['"a/say \\"grüße\\".txt" "b/say \\"grüße\\".txt"', 'say "grüße".txt'],
    // A byte order mark at the start of a name is part of the name.
    ['"a/\\357\\273\\277bom.txt" "b/\\357\\273\\277bom.txt"', `${BYTE_ORDER_MARK}bom.txt`],
  ]) {
    assert.deepEqual(gitDiffPaths(header(names, 'index 5626abf..f719efd 100644')), { oldPath: path, newPath: path }, names)
  }
})

test('quotes a path exactly as Git does, and reads back every quoted byte', () => {
  for (const [path, quoted] of [
    ['a/Meeting notes.md', 'a/Meeting notes.md'],
    ['a/grüße.txt', '"a/gr\\303\\274\\303\\237e.txt"'],
    ['a/say "hi".txt', '"a/say \\"hi\\".txt"'],
    ['a/back\\slash.txt', '"a/back\\\\slash.txt"'],
    ['a/tab\there.txt', '"a/tab\\there.txt"'],
    ['a/new\nline.txt', '"a/new\\nline.txt"'],
  ]) assert.equal(quoteGitPath(path), quoted)
  const everyControlCharacter = Array.from({ length: 0x20 }, (_, code) => String.fromCharCode(code)).join('')
  const name = `${everyControlCharacter}${String.fromCharCode(0x7f)} "\\ ü € ${String.fromCodePoint(0x1f600)}`
  assert.deepEqual(gitDiffPaths(`diff --git ${quoteGitPath(`a/${name}`)} ${quoteGitPath(`b/${name}`)}\n`), { oldPath: name, newPath: name })
})

test('reads renames and copies from their own header lines, whatever the quoting of each side', () => {
  assert.deepEqual(gitDiffPaths(header(
    'a/old name.txt "b/new name \\303\\274.txt"',
    'similarity index 100%', 'rename from old name.txt', 'rename to "new name \\303\\274.txt"',
  )), { oldPath: 'old name.txt', newPath: 'new name ü.txt' })
  assert.deepEqual(gitDiffPaths(header(
    'a/old name.txt "b/gr\\303\\274\\303\\237e copy.txt"',
    'similarity index 100%', 'copy from old name.txt', 'copy to "gr\\303\\274\\303\\237e copy.txt"',
  )), { oldPath: 'old name.txt', newPath: 'grüße copy.txt' })
  assert.deepEqual(gitDiffPaths(header(
    'a/x b/y b/z b/w', 'similarity index 90%', 'rename from x b/y', 'rename to z b/w', 'index 1111111..2222222 100644',
  ) + '--- a/x b/y\t\n+++ b/z b/w\t\n@@ -1 +1 @@\n-rename from elsewhere\n+rename to elsewhere\n'), { oldPath: 'x b/y', newPath: 'z b/w' })
})

test('gives no paths for a header whose names cannot be read exactly', () => {
  for (const names of [
    // Latin-1 bytes: not a UTF-8 name, so no exact path exists for it.
    '"a/caf\\351" "b/caf\\351"',
    '"a/bad\\qescape" "b/bad\\qescape"',
    '"a/unterminated "b/unterminated"',
    '"a/same" "b/other"',
    'a/one b/other',
    'a/missing-prefix x/missing-prefix',
  ]) {
    assert.equal(gitDiffPaths(header(names)), null, names)
    assert.equal(canDiscardGitPatch(header(names) + '@@ -1 +1 @@\n-a\n+b\n'), false, names)
  }
  assert.equal(gitDiffPaths(header('a/x b/x', 'rename from x')), null, 'a rename needs both of its lines')
  assert.equal(gitDiffPaths('not a patch\n'), null)
})

test('discard accepts quoted names and refuses symbolic link and submodule changes on the index line', () => {
  const quoted = header('"a/gr\\303\\274\\303\\237e.txt" "b/gr\\303\\274\\303\\237e.txt"', 'index 5626abf..f719efd 100644')
    + '--- "a/gr\\303\\274\\303\\237e.txt"\n+++ "b/gr\\303\\274\\303\\237e.txt"\n@@ -1 +1,2 @@\n one\n+two\n'
  assert.equal(canDiscardGitPatch(quoted), true)
  const symlinkTarget = header('a/link b/link', 'index 52c028e..299266f 120000')
    + '--- a/link\n+++ b/link\n@@ -1 +1 @@\n-app/a.txt\n\\ No newline at end of file\n+root.txt\n\\ No newline at end of file\n'
  assert.equal(canDiscardGitPatch(symlinkTarget), false)
  const submoduleCommit = header('a/mod b/mod', 'index ad43249..ace12e6 160000')
    + '--- a/mod\n+++ b/mod\n@@ -1 +1 @@\n-Subproject commit ad4324920864b44d744d139c648c2e15fd8f67c5\n'
    + '+Subproject commit ace12e6caf8872dbab04614afdaf1f69cae16c5b\n'
  assert.equal(canDiscardGitPatch(submoduleCommit), false)
})

test('a combined diff of a conflicted file is never glued onto the patch before it', () => {
  const combined = 'diff --cc c.txt\nindex ba2906d,e45c9c2..0000000\n--- a/c.txt\n+++ b/c.txt\n'
    + '@@@ -1,1 -1,1 +1,5 @@@\n++<<<<<<< HEAD\n +main\n++=======\n+ other\n++>>>>>>> other\n'
  const second = patch.replaceAll('a.txt', 'd.txt')
  assert.deepEqual(splitGitDiff(patch + combined + second), [patch, second])
})
