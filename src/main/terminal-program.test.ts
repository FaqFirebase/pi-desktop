import assert from 'node:assert/strict'
import { test } from 'node:test'
import { terminalProgramFor } from './terminal-program'

const COMSPEC = 'C:\\Windows\\System32\\cmd.exe'

test('a native editor binary starts directly with its arguments', () => {
  assert.deepEqual(terminalProgramFor('/usr/bin/nvim', ['+3', '/p/a b.ts'], false, ''), { file: '/usr/bin/nvim', args: ['+3', '/p/a b.ts'] })
  assert.deepEqual(terminalProgramFor('C:\\N\\nvim.exe', ['+3', 'C:\\p\\a.ts'], true, COMSPEC), { file: 'C:\\N\\nvim.exe', args: ['+3', 'C:\\p\\a.ts'] })
})

test('a Windows .cmd shim starts through cmd.exe with escaped arguments', () => {
  assert.deepEqual(terminalProgramFor('C:\\s\\hx.cmd', ['C:\\p\\a b.ts'], true, COMSPEC),
    { file: COMSPEC, args: '/d /s /c "C:\\s\\hx.cmd "C:\\p\\a b.ts""' })
})

test('a .cmd name off Windows is a native program', () => {
  assert.deepEqual(terminalProgramFor('/x/hx.cmd', ['/p/a.ts'], false, ''), { file: '/x/hx.cmd', args: ['/p/a.ts'] })
})
