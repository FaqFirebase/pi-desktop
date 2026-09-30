import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('the action bar follows the same refresh triggers as the diff list', () => {
  const source = readFileSync(new URL('./git-conveyor-actions.tsx', import.meta.url), 'utf8')
  assert.match(source, /useEffect\(\(\) => subscribeWorktreeRefresh\(refresh, watchDisk\), \[refresh, watchDisk\]\)/)
  const diffViewer = readFileSync(new URL('./diff-viewer.tsx', import.meta.url), 'utf8')
  assert.match(diffViewer, /<GitConveyorActions [^>]*watchDisk=\{visible\}/)
})
