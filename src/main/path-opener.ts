import { posix as posixPath, win32 as win32Path } from 'node:path'
import {
  resolvePreferredEditor,
  type EditorId,
  type OpenPathRefusal,
  type OpenPathRequest,
  type OpenPathResult,
} from '../shared/editors'
import { buildEditorArgs, toDetectedEditor, type EditorInstall } from './editor-detection'
import { isRunnableTarget, resolveOpenPathTarget, type PathFacts } from './open-path-policy'
import type { TerminalProgram } from './terminal-program'

/** Every effect the path opener has, injected so its rules test without Electron. */
export interface PathOpenerDeps {
  platform: NodeJS.Platform
  /** Folders an action may act in. */
  roots(): string[]
  /** The folder a relative path resolves against. */
  baseDir(): string | null
  /** Facts about the path a link points at; null when it does not exist. */
  stat(path: string): Promise<PathFacts | null>
  realPath(path: string): string | null
  preferredEditor(): Promise<EditorId | null>
  installs(): EditorInstall[]
  /** Drop the cached editor list, so the next open finds editors again. */
  forgetInstalls(): void
  /** Start a GUI editor detached; false when it did not start. */
  launch(executable: string, args: string[], cwd: string): Promise<boolean>
  activeWorkspaceId(): string | null
  isEditorTerminalRunning(workspaceId: string): boolean
  prepareEditorTerminal(workspaceId: string, program: TerminalProgram): void
  terminalProgram(executable: string, args: string[]): TerminalProgram
  /** Open with the system app; false when the system could not open it. */
  openWithSystem(path: string): Promise<boolean>
  reveal(path: string): void
}

const OPENED: OpenPathResult = { ok: true, editorTerminalWorkspaceId: null }

function refused(refusal: OpenPathRefusal): OpenPathResult {
  return { ok: false, refusal }
}

/** The one entry point for "Open in editor", "Open with system app" and "Show in folder". */
export function createPathOpener(deps: PathOpenerDeps): (request: OpenPathRequest) => Promise<OpenPathResult> {
  const { dirname } = deps.platform === 'win32' ? win32Path : posixPath

  async function openWithSystem(target: string, facts: PathFacts): Promise<OpenPathResult> {
    if (isRunnableTarget([target, deps.realPath(target) ?? target], facts, deps.platform)) return refused('runnable-file')
    return (await deps.openWithSystem(target)) ? OPENED : refused('launch-failed')
  }

  function openInTerminalEditor(install: EditorInstall, args: string[]): OpenPathResult {
    const workspaceId = deps.activeWorkspaceId()
    if (workspaceId === null) return refused('no-terminal-workspace')
    if (deps.isEditorTerminalRunning(workspaceId)) {
      return { ok: false, refusal: 'editor-running', editorTerminalWorkspaceId: workspaceId }
    }
    deps.prepareEditorTerminal(workspaceId, deps.terminalProgram(install.executable, args))
    return { ok: true, editorTerminalWorkspaceId: workspaceId }
  }

  async function openInEditor(install: EditorInstall, target: string, facts: PathFacts, line: number | null): Promise<OpenPathResult> {
    const args = buildEditorArgs(install.editor.lineStyle, target, facts.isFile ? line : null)
    if (install.editor.inTerminal) return openInTerminalEditor(install, args)
    const cwd = facts.isFile ? dirname(target) : target
    if (await deps.launch(install.executable, args, cwd)) return OPENED
    deps.forgetInstalls()
    return refused('launch-failed')
  }

  return async (request) => {
    const target = resolveOpenPathTarget(request.path, deps.baseDir(), deps.roots(), deps.platform)
    if (target === null) return refused('outside-roots')
    const facts = await deps.stat(target)
    if (facts === null) return refused('not-found')
    if (request.action === 'reveal') {
      deps.reveal(target)
      return OPENED
    }
    if (request.action === 'editor') {
      const installs = deps.installs()
      const { editor } = resolvePreferredEditor(await deps.preferredEditor(), installs.map(toDetectedEditor))
      const install = editor && installs.find((candidate) => candidate.editor.id === editor.id)
      if (install) return openInEditor(install, target, facts, request.line ?? null)
    }
    return openWithSystem(target, facts)
  }
}
