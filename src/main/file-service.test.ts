import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { buildNewFileDiff, FileService } from './file-service'
import type { FileChangeEvent } from '../shared/ipc-contracts'

const diff = buildNewFileDiff('TEST.md', '# Test\n\nHello\n')

assert.equal(
  diff,
  [
    'diff --git a/TEST.md b/TEST.md',
    'new file mode 100644',
    'index 0000000..0000000',
    '--- /dev/null',
    '+++ b/TEST.md',
    '@@ -0,0 +1,3 @@',
    '+# Test',
    '+',
    '+Hello',
    '',
  ].join('\n')
)

// ─── startWatching ────────────────────────────────────────────────────────

function waitForChange(timeoutMs: number): {
  promise: Promise<FileChangeEvent[]>
  onChange: (event: FileChangeEvent) => void
} {
  const events: FileChangeEvent[] = []
  let resolve!: (value: FileChangeEvent[]) => void
  const promise = new Promise<FileChangeEvent[]>((res) => {
    resolve = res
  })
  const onChange = (event: FileChangeEvent): void => {
    events.push(event)
    resolve(events)
  }
  setTimeout(() => resolve(events), timeoutMs)
  return { promise, onChange }
}

async function testWatcherEmitsOnChange(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-fs-watch-'))
  const service = new FileService(dir)
  const { promise, onChange } = waitForChange(3000)

  service.startWatching(onChange)
  // Give chokidar a moment to finish its initial scan before mutating.
  await new Promise((r) => setTimeout(r, 300))
  await writeFile(join(dir, 'hello.txt'), 'hi')

  const events = await promise
  service.stopWatching()

  assert.ok(events.length > 0, 'expected at least one debounced file-change event')
  assert.equal(events[events.length - 1].relativePath, 'hello.txt')
}

async function testWatcherIgnoresHeavyDirs(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-fs-ignore-'))
  await mkdir(join(dir, 'node_modules'), { recursive: true })
  const service = new FileService(dir)
  const { promise, onChange } = waitForChange(1500)

  service.startWatching(onChange)
  await new Promise((r) => setTimeout(r, 300))
  await writeFile(join(dir, 'node_modules', 'ignored.js'), 'x')

  const events = await promise
  service.stopWatching()

  assert.equal(events.length, 0, 'changes under node_modules must not emit events')
}

await testWatcherEmitsOnChange()
await testWatcherIgnoresHeavyDirs()
console.log('file-service watcher tests passed')
