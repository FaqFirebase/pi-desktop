import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WorkspaceTerminals } from './workspace-terminals'
import type { TerminalService } from './terminal-service'
import type { TerminalProgram } from './terminal-program'
import { EDITOR_TERMINAL_KEY_SUFFIX } from '../shared/terminal-slot'

const requiresProgram = (key: string) => key.endsWith(EDITOR_TERMINAL_KEY_SUFFIX)

function setup() {
  type ExitHandler = Parameters<TerminalService['start']>[2]
  const terminals: { inputs: string[]; sizes: number[][]; stops: number; starts: number; program?: TerminalProgram; emit: (data: string) => void; exit: ExitHandler }[] = []
  const pool = new WorkspaceTerminals(() => {
    const state = { inputs: [] as string[], sizes: [] as number[][], stops: 0, starts: 0, program: undefined as TerminalProgram | undefined, emit: (_data: string) => {}, exit: ((_event) => {}) as ExitHandler }
    terminals.push(state)
    return {
      start: (...[options, onData, onExit, program]: Parameters<TerminalService['start']>) => {
        state.starts++
        state.program = program
        state.emit = onData
        state.exit = onExit
        return { pid: terminals.length, shell: '/bin/sh', cwd: options.cwd ?? '/' }
      },
      write: (data) => { state.inputs.push(data) },
      resize: (cols, rows) => { state.sizes.push([cols, rows]) },
      stop: () => { state.stops++ },
    }
  }, requiresProgram)
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
  }), requiresProgram)
  assert.throws(() => pool.start('a', {}, noop, noop), /spawn failed/)
  assert.equal(pool.start('a', {}, noop, noop).pid, 1)
})

test('a shell slot starts the default shell program', () => {
  const { pool, terminals } = setup()
  pool.start('w', { cwd: '/w' }, noop, noop)
  assert.equal(terminals[0].program, undefined)
})

test('an editor slot starts the prepared program, not a shell', () => {
  const { pool, terminals } = setup()
  pool.prepare('w#editor', { file: '/usr/bin/vim', args: ['/w/a.ts'] })
  pool.start('w#editor', { cwd: '/w' }, noop, noop)
  assert.deepEqual(terminals[0].program, { file: '/usr/bin/vim', args: ['/w/a.ts'] })
})

test('the newest prepared program wins', () => {
  const { pool, terminals } = setup()
  pool.prepare('w#editor', { file: 'vim', args: ['/w/a.ts'] })
  pool.prepare('w#editor', { file: 'vim', args: ['/w/b.ts'] })
  pool.start('w#editor', {}, noop, noop)
  assert.deepEqual(terminals[0].program, { file: 'vim', args: ['/w/b.ts'] })
})

test('the shell and editor slots of one workspace are separate PTYs', () => {
  const { pool, terminals } = setup()
  pool.start('w', {}, noop, noop)
  pool.prepare('w#editor', { file: 'vim', args: [] })
  pool.start('w#editor', {}, noop, noop)
  pool.write('w#editor', ':q\r')
  assert.equal(terminals.length, 2)
  assert.deepEqual(terminals[0].inputs, [])
  assert.deepEqual(terminals[1].inputs, [':q\r'])
})

test('an editor exit frees the slot', () => {
  const { pool, terminals } = setup()
  pool.prepare('w#editor', { file: 'vim', args: [] })
  pool.start('w#editor', {}, noop, noop)
  assert.equal(pool.isRunning('w#editor'), true)
  terminals[0].exit({ exitCode: 0 })
  assert.equal(pool.isRunning('w#editor'), false)
})

test('an editor slot with no prepared program does not start', () => {
  const { pool } = setup()
  assert.throws(() => pool.start('w#editor', {}, noop, noop), /No editor is waiting to start/)
})

test('a started editor uses its prepared program once', () => {
  const { pool, terminals } = setup()
  pool.prepare('w#editor', { file: 'vim', args: [] })
  pool.start('w#editor', {}, noop, noop)
  terminals[0].exit({ exitCode: 0 })
  assert.throws(() => pool.start('w#editor', {}, noop, noop), /No editor is waiting to start/)
})

test('stopping a slot drops its prepared program', () => {
  const { pool } = setup()
  pool.prepare('w#editor', { file: 'vim', args: [] })
  pool.stop('w#editor')
  assert.throws(() => pool.start('w#editor', {}, noop, noop))
})
