import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EditorState } from '@codemirror/state'
import { gitLineMarkers, parseGitLineMarkers, setGitLineMarkers } from './code-editor-git'

const diff = (hunk: string) => `diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n${hunk}`

test('marks replacements and additional inserted lines, not context', () => {
  assert.deepEqual(parseGitLineMarkers(diff('@@ -1,3 +1,4 @@\n before\n-old\n+new\n+extra\n after')), [
    { line: 2, kind: 'modified' },
    { line: 3, kind: 'added' },
  ])
})

test('keeps separate changes within a hunk and across hunks at their new line numbers', () => {
  assert.deepEqual(parseGitLineMarkers(diff('@@ -1,3 +1,4 @@\n+first\n same\n-old\n+new\n same\n@@ -20 +21 @@\n-old\n+new')), [
    { line: 1, kind: 'added' },
    { line: 3, kind: 'modified' },
    { line: 21, kind: 'modified' },
  ])
})

test('anchors deletions before the next surviving line, including the start and end of a file', () => {
  assert.deepEqual(parseGitLineMarkers(diff('@@ -1,2 +1 @@\n-removed\n kept')), [{ line: 1, kind: 'deleted' }])
  assert.deepEqual(parseGitLineMarkers(diff('@@ -1,2 +1 @@\n kept\n-removed')), [{ line: 2, kind: 'deleted' }])
  assert.deepEqual(parseGitLineMarkers(diff('@@ -1 +0,0 @@\n-removed')), [{ line: 1, kind: 'deleted' }])
  assert.deepEqual(parseGitLineMarkers(diff('@@ -3,2 +2,0 @@\n-one\n-two')), [{ line: 3, kind: 'deleted' }])
})

test('a shrinking replacement has a modification and a deletion boundary', () => {
  assert.deepEqual(parseGitLineMarkers(diff('@@ -1,3 +1,2 @@\n-one\n-two\n+replacement\n kept')), [
    { line: 1, kind: 'modified' },
    { line: 2, kind: 'deleted' },
  ])
})

test('handles added files, content resembling diff headers and missing final newlines', () => {
  assert.deepEqual(parseGitLineMarkers(diff('@@ -0,0 +1,2 @@\n+++content\n+last\n\\ No newline at end of file')), [
    { line: 1, kind: 'added' },
    { line: 2, kind: 'added' },
  ])
  assert.deepEqual(parseGitLineMarkers(diff('@@ -1 +1 @@\n---old\n\\ No newline at end of file\n+++new\n\\ No newline at end of file')), [
    { line: 1, kind: 'modified' },
  ])
})

test('ignores clean, binary and mode-only diffs', () => {
  for (const text of ['', 'Binary files a/file and b/file differ', 'diff --git a/file b/file\nold mode 100644\nnew mode 100755']) {
    assert.deepEqual(parseGitLineMarkers(text), [])
  }
})

function markerPositions(state: EditorState): number[] {
  const positions: number[] = []
  const cursor = state.field(gitLineMarkers).iter()
  while (cursor.value) {
    positions.push(cursor.from)
    cursor.next()
  }
  return positions
}

test('saved markers follow their lines when text is inserted above them', () => {
  let state = EditorState.create({ doc: 'first\nchanged\nlast', extensions: [gitLineMarkers] })
  state = state.update({ effects: setGitLineMarkers.of([{ line: 2, kind: 'modified' }]) }).state
  state = state.update({ changes: { from: 0, insert: 'new\n' } }).state
  assert.deepEqual(markerPositions(state), [state.doc.line(3).from])
  state = state.update({ changes: { from: state.doc.line(3).from, insert: 'another\n' } }).state
  assert.deepEqual(markerPositions(state), [state.doc.line(4).from])
})

test('typing at a marked line start keeps the marker at a gutter-renderable position', () => {
  let state = EditorState.create({ doc: 'first\nchanged', extensions: [gitLineMarkers] })
  state = state.update({ effects: setGitLineMarkers.of([{ line: 2, kind: 'modified' }]) }).state
  state = state.update({ changes: { from: state.doc.line(2).from, insert: 'prefix ' } }).state
  assert.deepEqual(markerPositions(state), [state.doc.line(2).from])
})

test('removing a marked line removes its saved marker', () => {
  let state = EditorState.create({ doc: 'first\nchanged\nlast', extensions: [gitLineMarkers] })
  state = state.update({ effects: setGitLineMarkers.of([{ line: 2, kind: 'modified' }]) }).state
  state = state.update({ changes: { from: state.doc.line(2).from, to: state.doc.line(3).from } }).state
  assert.deepEqual(markerPositions(state), [])
})

test('a fresh diff replaces markers and a clean diff clears them', () => {
  let state = EditorState.create({ doc: 'first\nsecond', extensions: [gitLineMarkers] })
  state = state.update({ effects: setGitLineMarkers.of([{ line: 1, kind: 'added' }]) }).state
  state = state.update({ effects: setGitLineMarkers.of([{ line: 2, kind: 'modified' }]) }).state
  assert.deepEqual(markerPositions(state), [state.doc.line(2).from])
  state = state.update({ effects: setGitLineMarkers.of([]) }).state
  assert.deepEqual(markerPositions(state), [])
})

test('deletion at EOF attaches to the last available editor line, even for an empty file', () => {
  for (const doc of ['kept', '']) {
    let state = EditorState.create({ doc, extensions: [gitLineMarkers] })
    state = state.update({ effects: setGitLineMarkers.of([{ line: 2, kind: 'deleted' }]) }).state
    assert.deepEqual(markerPositions(state), [0])
  }
})
