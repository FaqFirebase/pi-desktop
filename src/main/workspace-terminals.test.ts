import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WorkspaceTerminals } from './workspace-terminals'
import type { TerminalService } from './terminal-service'

function setup() {
  type ExitHandler = Parameters<TerminalService['start']>[2]
  const terminals: { inputs: string[]; sizes: number[][]; stops: number; starts: number; emit: (data: string) => void; exit: ExitHandler }[] = []
  const pool = new WorkspaceTerminals(() => {
    const state = { inputs: [] as string[], sizes: [] as number[][], stops: 0, starts: 0, emit: (_data: string) => {}, exit: ((_event) => {}) as ExitHandler }
    terminals.push(state)
    return {
      start: (...[options, onData, onExit]: Parameters<TerminalService['start']>) => {
        state.starts++
        state.emit = onData
        state.exit = onExit
        return { pid: terminals.length, shell: '/bin/sh', cwd: options.cwd ?? '/' }
      },
      write: (data) => { state.inputs.push(data) },
      resize: (cols, rows) => { state.sizes.push([cols, rows]) },
      stop: () => { state.stops++ },
    }
  })
  return { pool, terminals }
}

const noop = () => {}

test('switching projects reuses the original PTY without restarting it', () => {
  const { pool, terminals } = setup()
  const first = pool.start('a', { cwd: '/a' }, noop, noop)
  pool.start('b', { cwd: '/b' }, noop, noop)
  assert.equal(pool.start('a', { cwd: '/a' }, noop, noop), first)
  assert.equal(terminals.length, 2)
  assert.deepEqual(terminals.map((t) => [t.starts, t.stops]), [[1, 0], [1, 0]])
})

test('input, size and background output remain isolated per workspace', () => {
  const { pool, terminals } = setup()
  const output: string[] = []
  pool.start('a', {}, (data) => output.push(`a:${data}`), noop)
  pool.start('b', {}, (data) => output.push(`b:${data}`), noop)
  pool.write('a', 'pwd\n')
  pool.resize('b', 100, 30)
  terminals[0].emit('background')
  terminals[1].emit('foreground')
  assert.deepEqual(output, ['a:background', 'b:foreground'])
  assert.deepEqual(terminals[0].inputs, ['pwd\n'])
  assert.deepEqual(terminals[1].inputs, [])
  assert.deepEqual(terminals[0].sizes, [])
  assert.deepEqual(terminals[1].sizes, [[100, 30]])
})

test('closing a project stops only its PTY; reopening starts a fresh session', () => {
  const { pool, terminals } = setup()
  pool.start('a', {}, noop, noop)
  pool.start('b', {}, noop, noop)
  pool.stop('a')
  pool.stop('a')
  pool.write('a', 'ignored')
  assert.deepEqual(terminals.map((t) => t.stops), [1, 0])
  assert.deepEqual(terminals[0].inputs, [])
  pool.start('a', {}, noop, noop)
  assert.equal(terminals.length, 3)
  pool.stopAll()
  pool.stopAll()
  assert.deepEqual(terminals.map((t) => t.stops), [1, 1, 1])
})

test('a shell that exits on its own is evicted so the next start respawns it', () => {
  const { pool, terminals } = setup()
  const exits: number[] = []
  pool.start('a', {}, noop, (event) => exits.push(event.exitCode))
  pool.start('b', {}, noop, noop)
  terminals[0].exit({ exitCode: 0 })
  assert.deepEqual(exits, [0])
  pool.write('a', 'ignored')
  assert.deepEqual(terminals[0].inputs, [])
  pool.start('a', {}, noop, noop)
  assert.equal(terminals.length, 3)
  assert.equal(terminals[1].starts, 1)
  pool.write('a', 'ls\n')
  assert.deepEqual(terminals[2].inputs, ['ls\n'])
})

test('a late exit from a replaced shell keeps the new entry', () => {
  const { pool, terminals } = setup()
  pool.start('a', {}, noop, noop)
  pool.stop('a')
  const fresh = pool.start('a', {}, noop, noop)
  terminals[0].exit({ exitCode: 1 })
  assert.equal(pool.start('a', {}, noop, noop), fresh)
  assert.equal(terminals.length, 2)
})

test('a failed spawn is not cached', () => {
  let attempts = 0
  const pool = new WorkspaceTerminals(() => ({
    start: () => {
      if (++attempts === 1) throw new Error('spawn failed')
      return { pid: 1, shell: '/bin/sh', cwd: '/' }
    },
    write: noop, resize: noop, stop: noop,
  }))
  assert.throws(() => pool.start('a', {}, noop, noop), /spawn failed/)
  assert.equal(pool.start('a', {}, noop, noop).pid, 1)
})
