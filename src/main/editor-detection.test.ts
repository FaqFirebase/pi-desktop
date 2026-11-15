import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EDITOR_IDS } from '../shared/editors'
import type { ResolutionDeps } from './pi-binary-resolution'
import {
  KNOWN_EDITORS,
  buildEditorArgs,
  detectEditorInstalls,
  expandInstallPath,
  toDetectedEditor,
} from './editor-detection'

function filesDeps(files: readonly string[], env: NodeJS.ProcessEnv = {}, isWindows = false): ResolutionDeps {
  const present = new Set(files)
  return {
    isWindows,
    env,
    exists: (path) => present.has(path),
    isDirectory: () => false,
    listDir: () => [],
    capture: () => null,
  }
}

test('buildEditorArgs passes the line in each editor family form', () => {
  assert.deepEqual(buildEditorArgs('goto', '/p/a.ts', 12), ['--goto', '/p/a.ts:12'])
  assert.deepEqual(buildEditorArgs('colon', '/p/a.ts', 12), ['/p/a.ts:12'])
  assert.deepEqual(buildEditorArgs('jetbrains', '/p/a.ts', 12), ['--line', '12', '/p/a.ts'])
  assert.deepEqual(buildEditorArgs('plus', '/p/a.ts', 12), ['+12', '/p/a.ts'])
  assert.deepEqual(buildEditorArgs('neovide', '/p/a.ts', 12), ['--', '+12', '/p/a.ts'])
})

test('buildEditorArgs without a line passes the path alone', () => {
  for (const style of ['goto', 'colon', 'jetbrains', 'plus', 'neovide'] as const) {
    assert.deepEqual(buildEditorArgs(style, '/p', null), ['/p'])
  }
})

test('every spec editor is in the table exactly once', () => {
  assert.deepEqual(KNOWN_EDITORS.map((e) => e.id), [...EDITOR_IDS])
})

test('terminal editors are nvim, vim and hx only', () => {
  assert.deepEqual(KNOWN_EDITORS.filter((e) => e.inTerminal).map((e) => e.id), ['neovim', 'vim', 'helix'])
})

test('expandInstallPath fills tokens and refuses a missing variable', () => {
  assert.equal(expandInstallPath('{HOME}/.local/bin/zed', { HOME: '/h' }), '/h/.local/bin/zed')
  assert.equal(expandInstallPath('{HOME}\\x', { USERPROFILE: 'C:\\U' }), 'C:\\U\\x')
  assert.equal(expandInstallPath('{LOCALAPPDATA}\\x', {}), null)
  assert.equal(expandInstallPath('{PROGRAMFILES}\\x', { ProgramFiles: '' }), null)
})

test('a CLI on PATH is found before an install path', () => {
  const deps = filesDeps(['/usr/bin/code', '/usr/share/code/bin/code'])
  const [install] = detectEditorInstalls(deps, 'linux', '/usr/bin')
  assert.equal(install.editor.id, 'vscode')
  assert.equal(install.executable, '/usr/bin/code')
})

test('an install path is found when the CLI is not on PATH', () => {
  const deps = filesDeps(['/Applications/Zed.app/Contents/MacOS/cli'])
  assert.deepEqual(detectEditorInstalls(deps, 'darwin', '').map((i) => i.executable), ['/Applications/Zed.app/Contents/MacOS/cli'])
})

test('a Linux Toolbox script is found under the home folder', () => {
  const deps = filesDeps(['/h/.local/share/JetBrains/Toolbox/scripts/goland'], { HOME: '/h' })
  assert.deepEqual(detectEditorInstalls(deps, 'linux', '').map((i) => i.editor.id), ['goland'])
})

test('a Windows Toolbox script is found with its .cmd name', () => {
  const deps = filesDeps(['C:\\L\\JetBrains\\Toolbox\\scripts\\rider.cmd'], { LOCALAPPDATA: 'C:\\L' }, true)
  assert.equal(detectEditorInstalls(deps, 'win32', '')[0].editor.id, 'rider')
})

test('nothing installed means an empty list', () => {
  assert.deepEqual(detectEditorInstalls(filesDeps([]), 'linux', ''), [])
})

test('a detected editor carries its name and terminal flag', () => {
  const deps = filesDeps(['/usr/bin/nvim'])
  assert.deepEqual(detectEditorInstalls(deps, 'linux', '/usr/bin').map(toDetectedEditor), [
    { id: 'neovim', name: 'Neovim', inTerminal: true },
  ])
})
