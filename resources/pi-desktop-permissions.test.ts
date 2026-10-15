import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { PERMISSION_RULES_FILE_NAME, WORKSPACE_RULES_DIR_NAME } from './permission-rules'
import { REPO_MAP_ENV, serializeRepoMap } from './repo-set-map'

// The settings the GUI hands the extension when it starts Pi or OMP.
const MODE_ENV = 'PI_DESKTOP_PERMISSION_MODE'
const RULES_PATH_ENV = 'PI_DESKTOP_PERMISSION_RULES_PATH'
const WORKSPACE_TRUSTED_ENV = 'PI_DESKTOP_WORKSPACE_TRUSTED'
const LOCALES_DIR_ENV = 'PI_DESKTOP_LOCALES_DIR'
const LANGUAGE_ENV = 'PI_DESKTOP_LANGUAGE'
const TRUSTED_MODE = 'trusted'
const ASK_EDITS_MODE = 'ask-edits'
const ENGLISH = 'en'

const RESOURCES_DIR = dirname(fileURLToPath(import.meta.url))
const EXTENSION_URL = pathToFileURL(join(RESOURCES_DIR, 'pi-desktop-permissions.ts')).href
const LOCALES_DIR = join(RESOURCES_DIR, 'locales')
// Windows needs elevation for symlinks; the checks stay POSIX-tested.
const SKIP_WITHOUT_SYMLINKS = process.platform === 'win32'

const AST_OPS = [{ pat: 'oldName($A)', out: 'newName($A)' }]
const HASHLINE_INPUT = '@@ multi-file hashline edit body'

interface ToolCallEvent {
  type: 'tool_call'
  toolCallId: string
  toolName: string
  input: unknown
}
interface ConfirmContext {
  ui: { confirm(title: string, message: string): Promise<boolean> }
}
type ToolCallHandler = (event: ToolCallEvent, ctx: ConfirmContext) => Promise<{ block?: boolean; reason?: string } | undefined>

interface ToolCallOutcome {
  /** The approval prompt shown, or null when the call went ahead without one. */
  prompt: string | null
  /** The block reason, or null when the call was not blocked. */
  blocked: string | null
}

let loadedCopies = 0

/**
 * Load a fresh copy of the extension the way Pi and OMP do: its default
 * export registers a `tool_call` handler. It reads its settings from the
 * environment when it loads, so each copy is its own module instance.
 */
async function loadExtension(settings: Record<string, string | undefined>): Promise<ToolCallHandler> {
  for (const [name, value] of Object.entries(settings)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  loadedCopies += 1
  const extension = await import(`${EXTENSION_URL}?copy=${loadedCopies}`) as { default: (pi: ExtensionAPI) => void }
  let handler: ToolCallHandler | undefined
  const pi = {
    on(event: string, registered: ToolCallHandler) {
      if (event === 'tool_call') handler = registered
    },
  }
  extension.default(pi as unknown as ExtensionAPI)
  assert.ok(handler, 'the extension registers a tool_call handler')
  return handler
}

/** Run one tool call with `cwd` as the agent's working directory. The user denies every prompt. */
async function runToolCall(handler: ToolCallHandler, cwd: string, toolName: string, input: unknown): Promise<ToolCallOutcome> {
  let prompt: string | null = null
  const previous = process.cwd()
  process.chdir(cwd)
  try {
    const result = await handler(
      { type: 'tool_call', toolCallId: 'call-1', toolName, input },
      { ui: { confirm: async (title, message) => { prompt = `${title}\n\n${message}`; return false } } },
    )
    return { prompt, blocked: result?.block ? result.reason ?? '' : null }
  } finally {
    process.chdir(previous)
  }
}

interface LinkedTask {
  root: string
  /** The main and linked checkouts as the repo map names them. */
  app: string
  lib: string
  /** A folder outside both checkouts. */
  outside: string
  handler: ToolCallHandler
}

/**
 * A two-repository linked task in Trusted mode. The linked repository is not
 * trusted, so only its deny rules apply: it denies `ast_edit`. With
 * `dataLink`, the GUI data folder that holds the worktrees is reached
 * through a symlink, so the repo map holds paths through the link while the
 * agent's working directory is the real path, as after a spawn.
 */
async function createLinkedTask(dataLink: boolean): Promise<LinkedTask> {
  const root = await mkdtemp(join(tmpdir(), 'pi-desktop-permissions-'))
  const realData = join(root, 'data')
  await mkdir(join(realData, 'worktrees', 'app', 'src'), { recursive: true })
  await mkdir(join(realData, 'worktrees', 'lib', 'src'), { recursive: true })
  let data = realData
  if (dataLink) {
    data = join(root, 'data-link')
    await symlink(realData, data, 'dir')
  }
  const app = join(data, 'worktrees', 'app')
  const lib = join(data, 'worktrees', 'lib')
  const outside = join(root, 'outside')
  await mkdir(outside)
  await mkdir(join(lib, WORKSPACE_RULES_DIR_NAME))
  await writeFile(
    join(lib, WORKSPACE_RULES_DIR_NAME, PERMISSION_RULES_FILE_NAME),
    JSON.stringify({ version: 1, rules: [{ action: 'deny', tool: 'ast_edit' }] }),
  )
  const mapPath = join(root, 'repo-map.json')
  await writeFile(mapPath, serializeRepoMap({
    setName: 'Shop',
    mode: 'isolated',
    repos: [
      { name: 'app', role: 'main', workPath: app, branch: 'pi/rename', trusted: false },
      { name: 'lib', role: 'linked', workPath: lib, branch: 'pi/rename', trusted: false },
    ],
  }))
  const handler = await loadExtension({
    [MODE_ENV]: TRUSTED_MODE,
    [RULES_PATH_ENV]: undefined,
    [WORKSPACE_TRUSTED_ENV]: undefined,
    [REPO_MAP_ENV]: mapPath,
    [LOCALES_DIR_ENV]: LOCALES_DIR,
    [LANGUAGE_ENV]: ENGLISH,
  })
  return { root, app, lib, outside, handler }
}

async function assertAsks(task: LinkedTask, toolName: string, input: unknown): Promise<void> {
  const outcome = await runToolCall(task.handler, task.app, toolName, input)
  assert.ok(outcome.prompt, `${toolName} ${JSON.stringify(input)} must ask`)
  assert.match(outcome.blocked ?? '', new RegExp(`User denied ${toolName}`), `a denied ${toolName} is blocked`)
}

async function assertGoesAhead(task: LinkedTask, toolName: string, input: unknown): Promise<void> {
  const outcome = await runToolCall(task.handler, task.app, toolName, input)
  assert.deepEqual(outcome, { prompt: null, blocked: null }, `${toolName} ${JSON.stringify(input)} must go ahead`)
}

describe('linked task in Trusted mode', { skip: SKIP_WITHOUT_SYMLINKS }, () => {
  let task: LinkedTask

  before(async () => {
    task = await createLinkedTask(false)
    await writeFile(join(task.outside, 'secret.txt'), 'secret\n')
    // Symlinks committed inside the main repository.
    await symlink(join(task.outside, 'secret.txt'), join(task.app, 'secret-link.txt'))
    await symlink(task.outside, join(task.app, 'outside-dir'), 'dir')
    await symlink(join(task.outside, 'missing.txt'), join(task.app, 'dangling.txt'))
  })

  after(async () => {
    await rm(task.root, { recursive: true, force: true })
  })

  it('asks before a write that the engine expands to a place outside the repositories', async () => {
    for (const path of [
      '~',
      '~/.bashrc',
      `@${join(task.outside, 'a.txt')}`,
      pathToFileURL(join(task.outside, 'a.txt')).href,
      '~other/.bashrc',
      '../../../outside/a.txt',
      join(task.outside, 'a.txt'),
    ]) {
      await assertAsks(task, 'write', { path, content: 'x' })
    }
  })

  it('asks before an OMP edit when any of its paths, or a rename target, is outside', async () => {
    await assertAsks(task, 'ast_edit', { ops: AST_OPS, paths: ['src/**/*.ts', join(task.outside, '**/*.ts')] })
    await assertAsks(task, 'ast_edit', { ops: AST_OPS, paths: [`{src,${task.outside}}/*.ts`] })
    await assertAsks(task, 'ast_edit', { ops: AST_OPS, paths: ['src/**/../../x.ts'] })
    await assertAsks(task, 'edit', { input: HASHLINE_INPUT, paths: ['src/a.ts', join(task.outside, 'b.ts')] })
    await assertAsks(task, 'edit', { path: 'src/a.ts', edits: [{ op: 'update', rename: join(task.outside, 'moved.ts') }] })
  })

  it('asks before a write through a committed symlink that leads outside', async () => {
    for (const path of ['secret-link.txt', 'outside-dir/new.txt', 'dangling.txt']) {
      await assertAsks(task, 'write', { path, content: 'x' })
    }
  })

  it('asks before a write tool call with no path it can check', async () => {
    await assertAsks(task, 'write', { content: 'x' })
    await assertAsks(task, 'ast_edit', { ops: AST_OPS })
  })

  it('lists every file a multi-file write names in the prompt', async () => {
    const moved = join(task.outside, 'moved.ts')
    const outcome = await runToolCall(task.handler, task.app, 'edit', { path: 'src/a.ts', edits: [{ op: 'update', rename: moved }] })
    assert.ok(outcome.prompt?.includes(`Target: src/a.ts\nTarget: ${moved}`), outcome.prompt ?? 'no prompt')
  })

  it('does not ask for writes inside the repositories, reads, or shell commands', async () => {
    await assertGoesAhead(task, 'edit', { path: 'src/index.ts', edits: [{ oldText: 'a', newText: 'b' }] })
    await assertGoesAhead(task, 'write', { path: '@src/new.ts', content: 'x' })
    await assertGoesAhead(task, 'write', { path: join(task.lib, 'src', 'api.ts'), content: 'x' })
    await assertGoesAhead(task, 'write', { path: pathToFileURL(join(task.app, 'src', 'url.ts')).href, content: 'x' })
    await assertGoesAhead(task, 'edit', { input: HASHLINE_INPUT, paths: ['src/a.ts', '../lib/src/b.ts'] })
    await assertGoesAhead(task, 'edit', { path: 'src/a.ts', edits: [{ op: 'update', rename: 'src/b.ts' }] })
    await assertGoesAhead(task, 'ast_edit', { ops: AST_OPS, paths: ['src/**/*.{ts,tsx}'] })
    await assertGoesAhead(task, 'read', { path: '~/.bashrc' })
    await assertGoesAhead(task, 'bash', { command: 'cp notes.txt ~/.bashrc' })
  })

  it('applies the rules of the repository each path is in, and the strictest decision wins', async () => {
    const intoLib = await runToolCall(task.handler, task.app, 'ast_edit', { ops: AST_OPS, paths: ['../lib/src/**/*.ts'] })
    assert.deepEqual(intoLib, { prompt: null, blocked: 'Blocked by permission rule: deny ast_edit' })
    const acrossBoth = await runToolCall(task.handler, task.app, 'ast_edit', { ops: AST_OPS, paths: ['src/**/*.ts', join(task.lib, 'src', '**', '*.ts')] })
    assert.deepEqual(acrossBoth, { prompt: null, blocked: 'Blocked by permission rule: deny ast_edit' })
  })
})

describe('linked task whose worktrees are reached through a symlinked data folder', { skip: SKIP_WITHOUT_SYMLINKS }, () => {
  let task: LinkedTask

  before(async () => {
    task = await createLinkedTask(true)
  })

  after(async () => {
    await rm(task.root, { recursive: true, force: true })
  })

  it('does not ask for a relative edit inside the repositories', async () => {
    await assertGoesAhead(task, 'edit', { path: 'src/index.ts', edits: [{ oldText: 'a', newText: 'b' }] })
    await assertGoesAhead(task, 'write', { path: '../lib/src/api.ts', content: 'x' })
    await assertGoesAhead(task, 'write', { path: join(task.lib, 'src', 'api.ts'), content: 'x' })
  })

  it('applies the rules of the linked repository to a relative path into it', async () => {
    const intoLib = await runToolCall(task.handler, task.app, 'ast_edit', { ops: AST_OPS, path: '../lib/src/api.ts' })
    assert.deepEqual(intoLib, { prompt: null, blocked: 'Blocked by permission rule: deny ast_edit' })
  })
})

describe('normal tab (no repo map)', () => {
  let root = ''

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'pi-desktop-permissions-single-'))
    await mkdir(join(root, 'src'))
  })

  after(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('keeps the mode decisions: Trusted never asks, Ask before edits asks', async () => {
    const singleRepo = {
      [RULES_PATH_ENV]: undefined,
      [WORKSPACE_TRUSTED_ENV]: undefined,
      [REPO_MAP_ENV]: undefined,
      [LOCALES_DIR_ENV]: LOCALES_DIR,
      [LANGUAGE_ENV]: ENGLISH,
    }
    const trusted = await loadExtension({ ...singleRepo, [MODE_ENV]: TRUSTED_MODE })
    assert.deepEqual(await runToolCall(trusted, root, 'write', { path: '~/.bashrc', content: 'x' }), { prompt: null, blocked: null })
    assert.deepEqual(await runToolCall(trusted, root, 'ast_edit', { ops: AST_OPS }), { prompt: null, blocked: null })

    const askEdits = await loadExtension({ ...singleRepo, [MODE_ENV]: ASK_EDITS_MODE })
    const edit = await runToolCall(askEdits, root, 'write', { path: 'src/a.ts', content: 'x' })
    assert.deepEqual(edit, {
      prompt: 'Allow write?\n\nPi wants to run the write tool.\n\nTarget: src/a.ts',
      blocked: 'User denied write permission in Pi Desktop.',
    })
    assert.deepEqual(await runToolCall(askEdits, root, 'read', { path: '~/.bashrc' }), { prompt: null, blocked: null })
  })
})
