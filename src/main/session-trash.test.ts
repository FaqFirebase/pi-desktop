import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTrashArgs, moveToTrash, type TrashSpawn, type TrashSpawnResult } from './session-trash'

/**
 * A deleted session must land in the desktop trash whenever the machine can
 * offer one. The regression these cover: trash-cli is absent on most installs,
 * and when the only helper was `trash`, every delete became a permanent
 * unlink with no undo.
 */

const NOT_INSTALLED: TrashSpawnResult = { status: null, error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) }
const SUCCEEDED: TrashSpawnResult = { status: 0 }
const REFUSED: TrashSpawnResult = { status: 1 }

function recordingSpawn(replies: Record<string, TrashSpawnResult>): { spawn: TrashSpawn; calls: Array<{ command: string; args: string[] }> } {
  const calls: Array<{ command: string; args: string[] }> = []
  const spawn: TrashSpawn = (command, args) => {
    calls.push({ command, args })
    return replies[command] ?? NOT_INSTALLED
  }
  return { spawn, calls }
}

test('trash-cli is used when it is installed, and nothing else is tried', () => {
  const { spawn, calls } = recordingSpawn({ trash: SUCCEEDED })
  assert.equal(moveToTrash('/home/u/.pi/agent/sessions/p/a.jsonl', spawn), true)
  assert.deepEqual(calls.map((c) => c.command), ['trash'])
})

test('a missing trash-cli falls through to gio instead of failing', () => {
  // This is the machine the sessions were lost on: no trash-cli, gio present.
  const { spawn, calls } = recordingSpawn({ trash: NOT_INSTALLED, gio: SUCCEEDED })
  assert.equal(moveToTrash('/home/u/.omp/agent/sessions/p/a.jsonl', spawn), true)
  assert.deepEqual(calls.map((c) => c.command), ['trash', 'gio'])
  assert.deepEqual(calls[1].args, ['trash', '/home/u/.omp/agent/sessions/p/a.jsonl'])
})

test('no helper installed reports failure so the caller can decide', () => {
  const { spawn, calls } = recordingSpawn({})
  assert.equal(moveToTrash('/home/u/.pi/agent/sessions/p/a.jsonl', spawn), false)
  // Every helper must be attempted before giving up on a recoverable delete.
  assert.deepEqual(calls.map((c) => c.command), ['trash', 'gio'])
})

test('a helper that runs and refuses is not treated as success', () => {
  const { spawn } = recordingSpawn({ trash: REFUSED, gio: REFUSED })
  assert.equal(moveToTrash('/home/u/.pi/agent/sessions/p/a.jsonl', spawn), false)
})

test('a refusal by one helper still lets the next one try', () => {
  const { spawn, calls } = recordingSpawn({ trash: REFUSED, gio: SUCCEEDED })
  assert.equal(moveToTrash('/home/u/.pi/agent/sessions/p/a.jsonl', spawn), true)
  assert.deepEqual(calls.map((c) => c.command), ['trash', 'gio'])
})

test('a path that could read as an option is separated with --', () => {
  assert.deepEqual(buildTrashArgs([], '-weird.jsonl'), ['--', '-weird.jsonl'])
  assert.deepEqual(buildTrashArgs(['trash'], '-weird.jsonl'), ['trash', '--', '-weird.jsonl'])
})

test('an ordinary absolute path is passed without a separator', () => {
  // Not every minimal `trash` build accepts `--`, so it is added only when needed.
  assert.deepEqual(buildTrashArgs([], '/home/u/a.jsonl'), ['/home/u/a.jsonl'])
  assert.deepEqual(buildTrashArgs(['trash'], '/home/u/a.jsonl'), ['trash', '/home/u/a.jsonl'])
})
