import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DisplayMessage } from '../message-parsing'
import { filterSessionDiffFiles } from './session-diff'

function call(name: string, args: unknown, extra = {}): DisplayMessage {
  return {
    id: name, role: 'assistant', content: '', timestamp: 0,
    toolCalls: [{ id: name, name, arguments: JSON.stringify(args), ...extra }],
  }
}

function diff(path: string) {
  return { oldPath: path, newPath: path, hunks: ['whole file diff'] }
}

test('filters edit/write files while retaining their full diff and order', () => {
  const files = [diff('src/a.ts'), diff('src/b.ts'), diff('src/other.ts')]
  const messages = [
    call('edit', { path: 'src/a.ts' }),
    call('write', { path: 'src/b.ts' }),
    call('edit', { path: './src/a.ts' }),
    call('read', { path: 'src/other.ts' }),
    call('bash', { command: 'echo changed > src/other.ts' }),
  ]
  const filtered = filterSessionDiffFiles(files, messages, '/project')
  assert.deepEqual(filtered, files.slice(0, 2))
  assert.equal(filtered[0], files[0])
  assert.equal(files.length, 3)
})

test('matches full paths, dot segments and supported tool argument aliases', () => {
  const files = [diff('src/a.ts'), diff('new file.ts')]
  assert.deepEqual(filterSessionDiffFiles(files, [
    call('functions.edit', { file_path: '/project/src/../src/a.ts' }),
    call('write', { filename: './new file.ts' }),
  ], '/project/'), files)
})

test('does not conflate basenames or outside-workspace paths', () => {
  const files = [diff('src/a.ts')]
  assert.deepEqual(filterSessionDiffFiles(files, [
    call('edit', { path: '/other/src/a.ts' }),
    call('write', { path: '../project-other/src/a.ts' }),
    call('edit', { path: 'a.ts' }),
  ], '/project'), [])
})

test('handles deleted and renamed files using either Git path', () => {
  const files = [
    { oldPath: 'old.ts', newPath: 'renamed.ts' },
    { oldPath: 'deleted.ts', newPath: 'deleted.ts' },
    diff('new.ts'),
  ]
  assert.deepEqual(filterSessionDiffFiles(files, [
    call('edit', { path: 'old.ts' }),
    call('edit', { path: 'deleted.ts' }),
    call('write', { path: 'new.ts' }),
  ], '/project'), files)
})

test('ignores malformed calls, failed results and in-progress writes', () => {
  const malformed = call('edit', {})
  malformed.toolCalls![0].arguments = 'not json'
  const result: DisplayMessage = {
    id: 'result', role: 'toolResult', content: 'failed', timestamp: 0,
    toolCallId: 'edit', isError: true,
  }
  assert.deepEqual(filterSessionDiffFiles([diff('a.ts')], [
    malformed,
    call('edit', { path: 'a.ts' }),
    result,
    call('write', { path: 'a.ts' }, { isError: true }),
    call('functions.write', { path: 'a.ts' }, { isExecuting: true }),
    call('write', { path: 42 }),
  ], '/project'), [])
})

test('changing session messages changes the filter without retaining previous paths', () => {
  const files = [diff('a.ts'), diff('b.ts')]
  assert.deepEqual(filterSessionDiffFiles(files, [call('write', { path: 'a.ts' })], '/project'), [files[0]])
  assert.deepEqual(filterSessionDiffFiles(files, [call('write', { path: 'b.ts' })], '/project'), [files[1]])
  assert.deepEqual(filterSessionDiffFiles(files, [], '/project'), [])
})

test('normalizes Windows separators and folds case only on Windows', (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'piDesktop')
  const bridge = { system: { platform: 'win32' } }
  Object.defineProperty(globalThis, 'piDesktop', { configurable: true, value: bridge })
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'piDesktop', original)
    else Reflect.deleteProperty(globalThis, 'piDesktop')
  })
  const files = [diff('src/App.ts')]
  assert.deepEqual(filterSessionDiffFiles(files, [
    call('edit', { path: 'c:\\PROJECT\\src\\app.ts' }),
  ], 'C:\\Project'), files)
  bridge.system.platform = 'linux'
  assert.deepEqual(filterSessionDiffFiles(files, [
    call('edit', { path: 'src/app.ts' }),
  ], '/project'), [])
})
