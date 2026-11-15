import { posix as posixPath, win32 as win32Path } from 'node:path'
import type { DetectedEditor, EditorId } from '../shared/editors'
import { whichInPath, type ResolutionDeps } from './pi-binary-resolution'

/**
 * How an editor takes a line number: `--goto file:line`, `file:line`,
 * `--line n file`, `+n file`, or `-- +n file` (the `--` hands `+n` to the
 * embedded terminal editor).
 */
export type LineStyle = 'goto' | 'colon' | 'jetbrains' | 'plus' | 'neovide'

export interface EditorDefinition {
  id: EditorId
  /** Product name, shown as is (never a translation key). */
  name: string
  /** Commands looked up on PATH, in order. */
  cliNames: readonly string[]
  /** Known executable locations per OS, with `{HOME}`, `{LOCALAPPDATA}` and `{PROGRAMFILES}` tokens. */
  installPaths: Readonly<Partial<Record<NodeJS.Platform, readonly string[]>>>
  lineStyle: LineStyle
  /** Runs inside a terminal, so it opens in the app's terminal panel. */
  inTerminal: boolean
}

export interface EditorInstall {
  editor: EditorDefinition
  executable: string
}

const VSCODE_NAME = 'Visual Studio Code'
const VSCODE_INSIDERS_NAME = 'Visual Studio Code - Insiders'
const VSCODIUM_NAME = 'VSCodium'
const CURSOR_NAME = 'Cursor'
const WINDSURF_NAME = 'Windsurf'
const ZED_NAME = 'Zed'
const SUBLIME_NAME = 'Sublime Text'
const INTELLIJ_IDEA_NAME = 'IntelliJ IDEA'
const PYCHARM_NAME = 'PyCharm'
const WEBSTORM_NAME = 'WebStorm'
const GOLAND_NAME = 'GoLand'
const RIDER_NAME = 'Rider'
const CLION_NAME = 'CLion'
const RUSTROVER_NAME = 'RustRover'
const PHPSTORM_NAME = 'PhpStorm'
const RUBYMINE_NAME = 'RubyMine'
const DATAGRIP_NAME = 'DataGrip'
const NEOVIM_NAME = 'Neovim'
const VIM_NAME = 'Vim'
const HELIX_NAME = 'Helix'
const NEOVIDE_NAME = 'Neovide'

const HOME_TOKEN = '{HOME}'
const LOCALAPPDATA_TOKEN = '{LOCALAPPDATA}'
const PROGRAMFILES_TOKEN = '{PROGRAMFILES}'
const INSTALL_PATH_TOKEN_PATTERN = /\{(HOME|LOCALAPPDATA|PROGRAMFILES)\}/g

const GOTO_FLAG = '--goto'
const JETBRAINS_LINE_FLAG = '--line'
const PLUS_LINE_PREFIX = '+'
const END_OF_OPTIONS = '--'
const LINE_SEPARATOR = ':'

const JETBRAINS_TOOLBOX_SCRIPT_DIRS = {
  linux: posixPath.join(HOME_TOKEN, '.local', 'share', 'JetBrains', 'Toolbox', 'scripts'),
  darwin: posixPath.join(HOME_TOKEN, 'Library', 'Application Support', 'JetBrains', 'Toolbox', 'scripts'),
  win32: win32Path.join(LOCALAPPDATA_TOKEN, 'JetBrains', 'Toolbox', 'scripts'),
} as const
const WINDOWS_SCRIPT_EXTENSION = '.cmd'

function macAppExecutable(appName: string, executable: string): string {
  return posixPath.join('/Applications', `${appName}.app`, 'Contents', 'MacOS', executable)
}

function jetBrainsEditor(id: EditorId, name: string, cli: string, macAppNames: readonly string[]): EditorDefinition {
  return {
    id,
    name,
    cliNames: [cli],
    installPaths: {
      darwin: [...macAppNames.map((appName) => macAppExecutable(appName, cli)), posixPath.join(JETBRAINS_TOOLBOX_SCRIPT_DIRS.darwin, cli)],
      win32: [win32Path.join(JETBRAINS_TOOLBOX_SCRIPT_DIRS.win32, cli + WINDOWS_SCRIPT_EXTENSION)],
      linux: [posixPath.join(JETBRAINS_TOOLBOX_SCRIPT_DIRS.linux, cli)],
    },
    lineStyle: 'jetbrains',
    inTerminal: false,
  }
}

function terminalEditor(id: EditorId, name: string, cliNames: readonly string[], lineStyle: LineStyle, win32: readonly string[] = []): EditorDefinition {
  return { id, name, cliNames, installPaths: { win32 }, lineStyle, inTerminal: true }
}

/** Every editor the app looks for, in the order Settings lists them. */
export const KNOWN_EDITORS: readonly EditorDefinition[] = [
  {
    id: 'vscode',
    name: VSCODE_NAME,
    cliNames: ['code'],
    installPaths: {
      darwin: ['/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'],
      win32: ['{LOCALAPPDATA}\\Programs\\Microsoft VS Code\\bin\\code.cmd', '{PROGRAMFILES}\\Microsoft VS Code\\bin\\code.cmd'],
      linux: ['/usr/share/code/bin/code', '/snap/bin/code'],
    },
    lineStyle: 'goto',
    inTerminal: false,
  },
  {
    id: 'vscode-insiders',
    name: VSCODE_INSIDERS_NAME,
    cliNames: ['code-insiders'],
    installPaths: {
      darwin: ['/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code'],
      win32: ['{LOCALAPPDATA}\\Programs\\Microsoft VS Code Insiders\\bin\\code-insiders.cmd'],
      linux: ['/usr/share/code-insiders/bin/code-insiders'],
    },
    lineStyle: 'goto',
    inTerminal: false,
  },
  {
    id: 'vscodium',
    name: VSCODIUM_NAME,
    cliNames: ['codium'],
    installPaths: {
      darwin: ['/Applications/VSCodium.app/Contents/Resources/app/bin/codium'],
      win32: ['{LOCALAPPDATA}\\Programs\\VSCodium\\bin\\codium.cmd', '{PROGRAMFILES}\\VSCodium\\bin\\codium.cmd'],
      linux: ['/usr/share/codium/bin/codium', '/snap/bin/codium'],
    },
    lineStyle: 'goto',
    inTerminal: false,
  },
  {
    id: 'cursor',
    name: CURSOR_NAME,
    cliNames: ['cursor'],
    installPaths: {
      darwin: ['/Applications/Cursor.app/Contents/Resources/app/bin/cursor'],
      win32: ['{LOCALAPPDATA}\\Programs\\cursor\\resources\\app\\bin\\cursor.cmd'],
      linux: ['/usr/share/cursor/bin/cursor'],
    },
    lineStyle: 'goto',
    inTerminal: false,
  },
  {
    id: 'windsurf',
    name: WINDSURF_NAME,
    cliNames: ['windsurf'],
    installPaths: {
      darwin: ['/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf'],
      win32: ['{LOCALAPPDATA}\\Programs\\Windsurf\\bin\\windsurf.cmd'],
      linux: ['/usr/share/windsurf/bin/windsurf'],
    },
    lineStyle: 'goto',
    inTerminal: false,
  },
  {
    id: 'zed',
    name: ZED_NAME,
    cliNames: ['zed', 'zeditor'],
    installPaths: {
      darwin: ['/Applications/Zed.app/Contents/MacOS/cli'],
      win32: ['{LOCALAPPDATA}\\Programs\\Zed\\bin\\zed.exe'],
      linux: ['{HOME}/.local/bin/zed'],
    },
    lineStyle: 'colon',
    inTerminal: false,
  },
  {
    id: 'sublime',
    name: SUBLIME_NAME,
    cliNames: ['subl'],
    installPaths: {
      darwin: ['/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl'],
      win32: ['{PROGRAMFILES}\\Sublime Text\\subl.exe'],
      linux: ['/opt/sublime_text/sublime_text'],
    },
    lineStyle: 'colon',
    inTerminal: false,
  },
  jetBrainsEditor('intellij-idea', INTELLIJ_IDEA_NAME, 'idea', [INTELLIJ_IDEA_NAME, `${INTELLIJ_IDEA_NAME} CE`]),
  jetBrainsEditor('pycharm', PYCHARM_NAME, 'pycharm', [PYCHARM_NAME, `${PYCHARM_NAME} CE`]),
  jetBrainsEditor('webstorm', WEBSTORM_NAME, 'webstorm', [WEBSTORM_NAME]),
  jetBrainsEditor('goland', GOLAND_NAME, 'goland', [GOLAND_NAME]),
  jetBrainsEditor('rider', RIDER_NAME, 'rider', [RIDER_NAME]),
  jetBrainsEditor('clion', CLION_NAME, 'clion', [CLION_NAME]),
  jetBrainsEditor('rustrover', RUSTROVER_NAME, 'rustrover', [RUSTROVER_NAME]),
  jetBrainsEditor('phpstorm', PHPSTORM_NAME, 'phpstorm', [PHPSTORM_NAME]),
  jetBrainsEditor('rubymine', RUBYMINE_NAME, 'rubymine', [RUBYMINE_NAME]),
  jetBrainsEditor('datagrip', DATAGRIP_NAME, 'datagrip', [DATAGRIP_NAME]),
  terminalEditor('neovim', NEOVIM_NAME, ['nvim'], 'plus', ['{PROGRAMFILES}\\Neovim\\bin\\nvim.exe']),
  terminalEditor('vim', VIM_NAME, ['vim'], 'plus'),
  terminalEditor('helix', HELIX_NAME, ['hx', 'helix'], 'colon'),
  {
    id: 'neovide',
    name: NEOVIDE_NAME,
    cliNames: ['neovide'],
    installPaths: {
      darwin: ['/Applications/Neovide.app/Contents/MacOS/neovide'],
      win32: ['{PROGRAMFILES}\\Neovide\\neovide.exe'],
    },
    lineStyle: 'neovide',
    inTerminal: false,
  },
]

function tokenValue(token: string, env: NodeJS.ProcessEnv): string | undefined {
  if (token === HOME_TOKEN) return env.HOME ?? env.USERPROFILE
  if (token === LOCALAPPDATA_TOKEN) return env.LOCALAPPDATA
  if (token === PROGRAMFILES_TOKEN) return env.ProgramFiles
  return undefined
}

/** Fill the tokens of an install path; null when a token's variable is missing or empty. */
export function expandInstallPath(template: string, env: NodeJS.ProcessEnv): string | null {
  let missing = false
  const expanded = template.replace(INSTALL_PATH_TOKEN_PATTERN, (token) => {
    const value = tokenValue(token, env)
    if (!value) missing = true
    return value ?? ''
  })
  return missing ? null : expanded
}

function findExecutable(deps: ResolutionDeps, editor: EditorDefinition, platform: NodeJS.Platform, pathEnv: string): string | null {
  for (const cli of editor.cliNames) {
    const onPath = whichInPath(deps, cli, pathEnv)
    if (onPath) return onPath
  }
  for (const template of editor.installPaths[platform] ?? []) {
    const candidate = expandInstallPath(template, deps.env)
    if (candidate && deps.exists(candidate) && !deps.isDirectory(candidate)) return candidate
  }
  return null
}

/** Installed editors in table order: a CLI on PATH first, else a known install path. */
export function detectEditorInstalls(deps: ResolutionDeps, platform: NodeJS.Platform, pathEnv: string): EditorInstall[] {
  const installs: EditorInstall[] = []
  for (const editor of KNOWN_EDITORS) {
    const executable = findExecutable(deps, editor, platform, pathEnv)
    if (executable) installs.push({ editor, executable })
  }
  return installs
}

export function toDetectedEditor(install: EditorInstall): DetectedEditor {
  return { id: install.editor.id, name: install.editor.name, inTerminal: install.editor.inTerminal }
}

/** Arguments that open `target`, at `line` when one is given. */
export function buildEditorArgs(style: LineStyle, target: string, line: number | null): string[] {
  if (line === null) return [target]
  switch (style) {
    case 'goto':
      return [GOTO_FLAG, `${target}${LINE_SEPARATOR}${line}`]
    case 'colon':
      return [`${target}${LINE_SEPARATOR}${line}`]
    case 'jetbrains':
      return [JETBRAINS_LINE_FLAG, String(line), target]
    case 'plus':
      return [`${PLUS_LINE_PREFIX}${line}`, target]
    case 'neovide':
      return [END_OF_OPTIONS, `${PLUS_LINE_PREFIX}${line}`, target]
  }
}
