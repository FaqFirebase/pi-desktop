import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { EditorId, OpenPathRequest } from '../shared/editors'
import { KNOWN_EDITORS, type EditorInstall } from './editor-detection'
import type { PathFacts } from './open-path-policy'
import { createPathOpener, type PathOpenerDeps } from './path-opener'
import type { TerminalProgram } from './terminal-program'

const FILE_FACTS: PathFacts = { isFile: true, mode: 0o644 }
const FOLDER_FACTS: PathFacts = { isFile: false, mode: 0o755 }

function install(id: EditorId, executable: string): EditorInstall {
  return { editor: KNOWN_EDITORS.find((editor) => editor.id === id)!, executable }
}

interface Options {
  preferred?: EditorId | null
  installs?: readonly EditorInstall[]
  activeWorkspaceId?: string | null
  editorRunning?: boolean
  launchOk?: boolean
  systemOk?: boolean
}

function setup(options: Options = {}) {
  const facts = new Map<string, PathFacts>([
    ['/w/a.ts', FILE_FACTS],
    ['/w/b.ts', FILE_FACTS],
    ['/w/run.sh', FILE_FACTS],
    ['/w/setup.exe', FILE_FACTS],
    ['/w/src', FOLDER_FACTS],
  ])
  const calls = {
    stat: 0,
    reveal: [] as string[],
    system: [] as string[],
    launch: [] as [string, string[], string][],
    prepare: [] as [string, TerminalProgram][],
    forgetInstalls: 0,
  }
  const deps: PathOpenerDeps = {
    platform: 'linux',
    roots: () => ['/w'],
    baseDir: () => '/w',
    stat: async (path) => {
      calls.stat++
      return facts.get(path) ?? null
    },
    realPath: (path) => path,
    preferredEditor: async () => options.preferred ?? null,
    installs: () => [...(options.installs ?? [])],
    forgetInstalls: () => { calls.forgetInstalls++ },
    launch: async (executable, args, cwd) => {
      calls.launch.push([executable, args, cwd])
      return options.launchOk ?? true
    },
    activeWorkspaceId: () => (options.activeWorkspaceId === undefined ? 'w1' : options.activeWorkspaceId),
    isEditorTerminalRunning: () => options.editorRunning ?? false,
    prepareEditorTerminal: (workspaceId, program) => { calls.prepare.push([workspaceId, program]) },
    terminalProgram: (file, args) => ({ file, args }),
    openWithSystem: async (path) => {
      calls.system.push(path)
      return options.systemOk ?? true
    },
    reveal: (path) => { calls.reveal.push(path) },
  }
  const open = createPathOpener(deps)
  return { open: (request: OpenPathRequest) => open(request), calls }
}

const VSCODE = { preferred: 'vscode', installs: [install('vscode', '/usr/bin/code')] } as const
const NEOVIM = { preferred: 'neovim', installs: [install('neovim', '/usr/bin/nvim')] } as const

test('a path outside every root is refused before any I/O', async () => {
  const { open, calls } = setup()
  assert.deepEqual(await open({ action: 'reveal', path: '/etc/passwd' }), { ok: false, refusal: 'outside-roots' })
  assert.equal(calls.stat, 0)
})

test('a missing file is refused', async () => {
  const { open } = setup()
  assert.deepEqual(await open({ action: 'reveal', path: '/w/gone.ts' }), { ok: false, refusal: 'not-found' })
})

test('Show in folder reveals the file', async () => {
  const { open, calls } = setup()
  assert.deepEqual(await open({ action: 'reveal', path: '/w/a.ts' }), { ok: true, editorTerminalWorkspaceId: null })
  assert.deepEqual(calls.reveal, ['/w/a.ts'])
})

test('a relative tool path resolves against the panel root', async () => {
  const { open, calls } = setup()
  await open({ action: 'reveal', path: 'a.ts' })
  assert.deepEqual(calls.reveal, ['/w/a.ts'])
})

test('a GUI editor launches with the line form', async () => {
  const { open, calls } = setup(VSCODE)
  assert.deepEqual(await open({ action: 'editor', path: '/w/a.ts', line: 7 }), { ok: true, editorTerminalWorkspaceId: null })
  assert.deepEqual(calls.launch, [['/usr/bin/code', ['--goto', '/w/a.ts:7'], '/w']])
})

test('a folder opens in the editor without a line', async () => {
  const { open, calls } = setup(VSCODE)
  await open({ action: 'editor', path: '/w/src', line: 7 })
  assert.deepEqual(calls.launch, [['/usr/bin/code', ['/w/src'], '/w/src']])
})

test('a terminal editor is prepared as its own program, never typed into a shell', async () => {
  const { open, calls } = setup(NEOVIM)
  assert.deepEqual(await open({ action: 'editor', path: '/w/a.ts', line: 3 }), { ok: true, editorTerminalWorkspaceId: 'w1' })
  assert.deepEqual(calls.prepare, [['w1', { file: '/usr/bin/nvim', args: ['+3', '/w/a.ts'] }]])
  assert.deepEqual(calls.launch, [])
})

test('a terminal editor with no workspace is refused', async () => {
  const { open, calls } = setup({ ...NEOVIM, activeWorkspaceId: null })
  assert.deepEqual(await open({ action: 'editor', path: '/w/a.ts' }), { ok: false, refusal: 'no-terminal-workspace' })
  assert.deepEqual(calls.prepare, [])
})

test('a second terminal editor open leaves the running editor alone', async () => {
  const { open, calls } = setup({ ...NEOVIM, editorRunning: true })
  assert.deepEqual(await open({ action: 'editor', path: '/w/b.ts' }), { ok: false, refusal: 'editor-running', editorTerminalWorkspaceId: 'w1' })
  assert.deepEqual(calls.prepare, [])
})

test('a missing saved editor falls back to the system app', async () => {
  const { open, calls } = setup({ preferred: 'zed', installs: [] })
  await open({ action: 'editor', path: '/w/a.ts' })
  assert.deepEqual(calls.system, ['/w/a.ts'])
  assert.deepEqual(calls.launch, [])
})

test('the system app refuses a runnable file and opens nothing', async () => {
  const { open, calls } = setup(VSCODE)
  assert.deepEqual(await open({ action: 'system', path: '/w/run.sh' }), { ok: false, refusal: 'runnable-file' })
  assert.deepEqual(calls.system, [])
  assert.deepEqual(calls.launch, [])
})

test('System default for a runnable file is refused too', async () => {
  const { open, calls } = setup({ preferred: null })
  assert.deepEqual(await open({ action: 'editor', path: '/w/setup.exe' }), { ok: false, refusal: 'runnable-file' })
  assert.deepEqual(calls.system, [])
})

test('the system app opens a plain file', async () => {
  const { open, calls } = setup()
  assert.deepEqual(await open({ action: 'system', path: '/w/a.ts' }), { ok: true, editorTerminalWorkspaceId: null })
  assert.deepEqual(calls.system, ['/w/a.ts'])
})

test('a failed launch clears the editor cache', async () => {
  const { open, calls } = setup({ ...VSCODE, launchOk: false })
  assert.deepEqual(await open({ action: 'editor', path: '/w/a.ts' }), { ok: false, refusal: 'launch-failed' })
  assert.equal(calls.forgetInstalls, 1)
})

test('a failed system open is its own refusal, not an editor failure', async () => {
  const { open, calls } = setup({ systemOk: false })
  assert.deepEqual(await open({ action: 'system', path: '/w/a.ts' }), { ok: false, refusal: 'system-open-failed' })
  assert.equal(calls.forgetInstalls, 0)
})

test('System default that fails to open is a system refusal too', async () => {
  const { open } = setup({ preferred: null, systemOk: false })
  assert.deepEqual(await open({ action: 'editor', path: '/w/a.ts' }), { ok: false, refusal: 'system-open-failed' })
})
