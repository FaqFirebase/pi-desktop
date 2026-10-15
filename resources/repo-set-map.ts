/**
 * The repo map: the one file that tells the agent extensions which git
 * repositories a linked task spans. The main process writes it before every
 * agent start and whenever a repository is added; the extensions read it on
 * every turn (mtime-cached), so both engines see a new repository on the next
 * turn without a restart.
 *
 * Shared by the main process and the extensions loaded into Pi and OMP, so it
 * may only depend on Node built-ins and other files under resources/ (no
 * Electron, no Pi APIs).
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, parse, posix, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isPathWithin, resolveRealPath } from './path-within'
import { getPrimaryInput } from './permission-rules'

/** Environment variable carrying the repo map path into the agent process. */
export const REPO_MAP_ENV = 'PI_DESKTOP_REPO_MAP_PATH'
export const REPO_MAP_VERSION = 1
/** Project instruction file each repository may carry for the agent. */
export const AGENTS_FILE_NAME = 'AGENTS.md'
/** XML-style tag wrapping the repo list in the agent's system prompt. */
export const REPO_MAP_PROMPT_TAG = 'linked-repositories'
/** Custom message type of the hidden note that announces a changed repo list (Pi and OMP). */
export const REPO_SET_CHANGE_MESSAGE_TYPE = 'pi-desktop-repo-set-change'

export type RepoRole = 'main' | 'linked'
export type LinkedTaskMode = 'isolated' | 'inPlace'

export interface RepoMapEntry {
  /** Display name, unique in the task. */
  name: string
  role: RepoRole
  /** The checkout the agent edits: a managed worktree, or the user's own checkout in place. */
  workPath: string
  /** Checked-out branch; null for a detached HEAD. */
  branch: string | null
  /** The user trusts this checkout: its own permission `allow` rules apply. */
  trusted: boolean
}

/** Engine-neutral context the app hands to the agent extensions. */
export interface RepoSetContext {
  setName: string
  mode: LinkedTaskMode
  repos: RepoMapEntry[]
}

interface RepoMapFile extends RepoSetContext {
  version: typeof REPO_MAP_VERSION
}

const ROLES: readonly RepoRole[] = ['main', 'linked']
const MODES: readonly LinkedTaskMode[] = ['isolated', 'inPlace']

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function parseEntry(value: unknown): RepoMapEntry | null {
  if (!isRecord(value)) return null
  const { name, role, workPath, branch, trusted } = value
  if (typeof name !== 'string' || !name) return null
  if (!ROLES.includes(role as RepoRole)) return null
  if (typeof workPath !== 'string' || !workPath) return null
  if (branch !== null && typeof branch !== 'string') return null
  if (typeof trusted !== 'boolean') return null
  return { name, role: role as RepoRole, workPath, branch, trusted }
}

/** The context in a parsed repo map file, or null when the data is not one. */
export function parseRepoMap(data: unknown): RepoSetContext | null {
  if (!isRecord(data) || data.version !== REPO_MAP_VERSION) return null
  if (typeof data.setName !== 'string' || !MODES.includes(data.mode as LinkedTaskMode)) return null
  if (!Array.isArray(data.repos)) return null
  const repos = data.repos.map(parseEntry)
  if (repos.some((repo) => repo === null)) return null
  const entries = repos as RepoMapEntry[]
  if (entries.filter((repo) => repo.role === 'main').length !== 1) return null
  return { setName: data.setName, mode: data.mode as LinkedTaskMode, repos: entries }
}

export function serializeRepoMap(context: RepoSetContext): string {
  const file: RepoMapFile = { version: REPO_MAP_VERSION, ...context }
  return JSON.stringify(file, null, 2)
}

interface CachedRepoMap {
  mtimeMs: number
  context: RepoSetContext | null
}

const repoMapCache = new Map<string, CachedRepoMap>()

/**
 * Read the repo map, re-parsing only when its mtime changes. A missing or
 * malformed file reads as null: the agent then runs as in a normal tab.
 */
export function loadRepoMap(filePath: string): RepoSetContext | null {
  let mtimeMs: number
  try {
    mtimeMs = statSync(filePath).mtimeMs
  } catch {
    repoMapCache.delete(filePath)
    return null
  }
  const cached = repoMapCache.get(filePath)
  if (cached && cached.mtimeMs === mtimeMs) return cached.context
  let context: RepoSetContext | null
  try {
    context = parseRepoMap(JSON.parse(readFileSync(filePath, 'utf-8')))
  } catch {
    context = null
  }
  if (!context) console.warn(`[pi-desktop] invalid repo map file ${filePath}`)
  repoMapCache.set(filePath, { mtimeMs, context })
  return context
}

// Path text forms Pi 0.86 (`normalizePath` in utils/paths.js, as its file
// tools call it) and OMP rewrite before they touch the disk: Unicode spaces
// become plain spaces, one leading `@` is dropped, `~` and `~/` (also `~\` on
// Windows) name the home folder, and a `file://` URL names a path.
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g
const PLAIN_SPACE = ' '
const AT_PREFIX = '@'
const HOME_PREFIX = '~'
const FILE_URL_PREFIX = 'file://'
// Forms the engines may read differently: a URL scheme of two characters or
// more (one is a drive letter), which Pi reads as a plain name, and on
// Windows the Git Bash, MSYS, Cygwin, and WSL drive paths (`/c/x`), which Pi
// maps to a drive.
const URL_SCHEME = /^[a-z][a-z\d+.-]+:/i
const WINDOWS_SHELL_DRIVE_PATH = /^[\\/](?:mnt[\\/]|cygdrive[\\/])?[a-z](?:[\\/]|$)/i

/**
 * The path a file tool uses for `text`, after the engine expands its own
 * prefixes; relative text stays relative to the agent's working directory.
 * Null for a form whose meaning is not known for both engines (`~user`, a
 * second `@`, another URL scheme, a Windows shell drive path), which callers
 * treat as outside.
 */
export function expandAgentPath(text: string, platform: NodeJS.Platform = process.platform, home: string = homedir()): string | null {
  const windows = platform === 'win32'
  let path = text.replace(UNICODE_SPACES, PLAIN_SPACE)
  if (path.startsWith(AT_PREFIX)) path = path.slice(AT_PREFIX.length)
  if (path.startsWith(AT_PREFIX)) return null
  if (windows && WINDOWS_SHELL_DRIVE_PATH.test(path)) return null
  if (path === HOME_PREFIX) return home
  if (path.startsWith(HOME_PREFIX)) {
    const separator = path.charAt(HOME_PREFIX.length)
    if (separator !== posix.sep && !(windows && separator === win32.sep)) return null
    return (windows ? win32 : posix).join(home, path.slice(HOME_PREFIX.length + separator.length))
  }
  if (path.startsWith(FILE_URL_PREFIX)) return fileUrlPath(path, windows)
  return URL_SCHEME.test(path) ? null : path
}

function fileUrlPath(url: string, windows: boolean): string | null {
  try {
    return fileURLToPath(url, { windows })
  } catch (error) {
    // Not a usable file URL (a host on POSIX, an encoded separator): the
    // engine cannot write to it either.
    if (error instanceof TypeError) return null
    throw error
  }
}

// Glob syntax of the pattern libraries the engines use: wildcards, classes,
// brace and extglob groups, negation.
const GLOB_SYNTAX = /[*?[\]{}()!]/
const GROUP_OPENERS = '{('
const GROUP_CLOSERS = '})'
const PARENT_FOLDER = '..'
const PATH_SEPARATORS = process.platform === 'win32' ? '\\/' : '/'

/**
 * The folder every match of the glob `pattern` stays in: the pattern up to
 * the segment with its first glob character (all of it when it has none).
 * Null when a match can leave that folder: a `..` in the glob part, or a
 * separator inside a brace or extglob group, whose alternatives may name any
 * folder.
 */
function globBase(pattern: string): string | null {
  const firstGlob = pattern.search(GLOB_SYNTAX)
  if (firstGlob === -1) return pattern
  const root = parse(pattern).root
  if (firstGlob < root.length) return null
  let cut = firstGlob
  while (cut > root.length && !PATH_SEPARATORS.includes(pattern.charAt(cut - 1))) cut--
  const globPart = pattern.slice(cut)
  if (globPart.includes(PARENT_FOLDER)) return null
  let depth = 0
  for (const char of globPart) {
    if (GROUP_OPENERS.includes(char)) depth++
    else if (GROUP_CLOSERS.includes(char)) depth = Math.max(0, depth - 1)
    else if (depth > 0 && PATH_SEPARATORS.includes(char)) return null
  }
  return pattern.slice(0, cut)
}

interface RealCheckout {
  repo: RepoMapEntry
  /** The checkout's real path, so a symlinked folder on the way to it still compares equal. */
  root: string
}

// One entry per map load: loadRepoMap returns the same context object until
// the file changes, so each checkout's real path is looked up once.
const realCheckoutsCache = new WeakMap<RepoSetContext, RealCheckout[]>()

/** The checkouts with their real paths. One whose real path is unknown holds no path, so writes into it ask. */
function realCheckouts(context: RepoSetContext): RealCheckout[] {
  let checkouts = realCheckoutsCache.get(context)
  if (!checkouts) {
    checkouts = context.repos.flatMap((repo) => {
      const root = resolveRealPath(resolve(repo.workPath))
      return root === null ? [] : [{ repo, root }]
    })
    realCheckoutsCache.set(context, checkouts)
  }
  return checkouts
}

/**
 * The checkout that holds the real path `real`. The deepest checkout wins, so
 * a worktree nested under another repository's folder still maps to itself.
 */
function checkoutHolding(checkouts: readonly RealCheckout[], real: string | null): RealCheckout | null {
  if (real === null) return null
  let best: RealCheckout | null = null
  for (const checkout of checkouts) {
    if (!isPathWithin(checkout.root, real)) continue
    if (!best || checkout.root.length > best.root.length) best = checkout
  }
  return best
}

/** The checkouts nested under the real folder `real`. */
function checkoutsUnder(checkouts: readonly RealCheckout[], real: string | null): RealCheckout[] {
  return real === null ? [] : checkouts.filter((checkout) => isPathWithin(real, checkout.root))
}

function realPathFrom(cwd: string, path: string | null): string | null {
  return path === null ? null : resolveRealPath(resolve(cwd, path))
}

/** Tools that create or change the files their path fields name (Pi and OMP). */
const FILE_WRITE_TOOLS = new Set(['edit', 'write', 'ast_edit'])
/** Write tools whose path fields may hold glob patterns (OMP `ast_edit`). */
const GLOB_PATH_TOOLS = new Set(['ast_edit'])
// Fields that name files in the write shapes of Pi and OMP: `path` (one
// file), `paths` (OMP `ast_edit` and multi-file edits), and `rename` (the new
// name in an OMP patch edit). OMP patch edits also carry them per entry of
// `edits`.
const PATH_FIELD = 'path'
const PATH_LIST_FIELD = 'paths'
const RENAME_FIELD = 'rename'
const EDITS_FIELD = 'edits'

/** Add the paths that `fields` names; false when one of those fields holds something other than text. */
function addNamedPaths(fields: Record<string, unknown>, paths: string[]): boolean {
  for (const name of [PATH_FIELD, RENAME_FIELD]) {
    const value = fields[name]
    if (value === undefined || value === null) continue
    if (typeof value !== 'string') return false
    paths.push(value)
  }
  const list = fields[PATH_LIST_FIELD]
  if (list === undefined || list === null) return true
  if (!Array.isArray(list) || !list.every((entry) => typeof entry === 'string')) return false
  paths.push(...list)
  return true
}

/**
 * The path texts a tool call names. For a file write: `path`, each `paths`
 * entry, and `rename`, also in each `edits` entry. For any other tool: its
 * `path`, the input the permission rules match (see getPrimaryInput). Null
 * when a field of a write holds something other than text, so its files
 * cannot be known.
 */
export function toolCallPaths(toolName: string, input: unknown): string[] | null {
  if (!FILE_WRITE_TOOLS.has(toolName)) {
    const primary = getPrimaryInput(toolName, input)
    return primary.kind === 'path' ? [primary.value] : []
  }
  if (!isRecord(input)) return []
  const paths: string[] = []
  if (!addNamedPaths(input, paths)) return null
  const edits = input[EDITS_FIELD]
  if (edits === undefined || edits === null) return paths
  if (!Array.isArray(edits)) return null
  for (const edit of edits) {
    if (isRecord(edit) && !addNamedPaths(edit, paths)) return null
  }
  return paths
}

/** Where one tool call acts in a linked task. */
export interface RepoSetToolCall {
  /**
   * The checkout of each path the call names, each checkout once; null for a
   * path outside every checkout. Empty when the call names no path, or when
   * its path fields cannot be read.
   */
  repos: (RepoMapEntry | null)[]
  /**
   * A file write that may land outside every checkout: a path outside them,
   * a path whose real location is not known, or no path to check.
   */
  leavesRepoSet: boolean
}

/**
 * Where a tool call acts in a linked task. Each path is read the way the
 * engine reads it (see expandAgentPath), resolved against `cwd` (the agent's
 * working directory), and compared by real path: a symlink that leads out of
 * a checkout counts as outside, and a checkout reached through a symlinked
 * folder still holds its relative paths. A glob of `ast_edit` also reaches
 * every checkout nested under its folder.
 *
 * A write outside the set is never blocked here, only routed to the normal
 * approval prompt, so the user decides. Shell commands are not inspected for
 * paths on purpose (owner decision, 2026-10-09): parsing them gives false
 * prompts, and the permission mode and rules already govern them.
 */
export function locateToolCall(context: RepoSetContext, toolName: string, input: unknown, cwd: string): RepoSetToolCall {
  const checkouts = realCheckouts(context)
  const paths = toolCallPaths(toolName, input)
  const repos = new Set<RepoMapEntry | null>()
  let outside = paths === null || paths.length === 0
  for (const text of paths ?? []) {
    const expanded = expandAgentPath(text)
    const holders = [checkoutHolding(checkouts, realPathFrom(cwd, expanded))]
    if (GLOB_PATH_TOOLS.has(toolName)) {
      const base = realPathFrom(cwd, expanded === null ? null : globBase(expanded))
      holders.push(checkoutHolding(checkouts, base), ...checkoutsUnder(checkouts, base))
    }
    for (const holder of holders) {
      repos.add(holder?.repo ?? null)
      if (!holder) outside = true
    }
  }
  return { repos: [...repos], leavesRepoSet: FILE_WRITE_TOOLS.has(toolName) && outside }
}

function describeRepo(repo: RepoMapEntry, hasAgentsFile: (path: string) => boolean): string {
  const role = repo.role === 'main' ? 'main repository, your working directory' : 'linked repository'
  const branch = repo.branch ? `branch ${repo.branch}` : 'detached HEAD'
  const agentsFile = join(repo.workPath, AGENTS_FILE_NAME)
  const rules = repo.role === 'linked' && hasAgentsFile(agentsFile) ? `; read its rules in ${agentsFile}` : ''
  return `- ${repo.name} (${role}): ${repo.workPath} — ${branch}${rules}`
}

/**
 * The block added to the agent's system prompt. It is English on purpose: it
 * is read by the model, not shown in the interface.
 */
export function formatRepoMapPrompt(
  context: RepoSetContext,
  hasAgentsFile: (path: string) => boolean = existsSync,
): string {
  const checkouts = context.mode === 'isolated'
    ? 'Each repository is a separate git worktree made for this task, all on the same branch.'
    : 'The repositories are the user\'s own checkouts, edited in place.'
  return [
    `<${REPO_MAP_PROMPT_TAG}>`,
    `This task is one linked change across the git repositories of the set "${context.setName}". ${checkouts}`,
    'Edit each repository only inside its path below, and use absolute paths for files outside your working directory.',
    'This list is current. When it differs from earlier messages in the conversation, follow this list.',
    ...context.repos.map((repo) => describeRepo(repo, hasAgentsFile)),
    'Keep the repositories consistent with each other. Unless the user asks, do not commit, push, or open pull requests: the user ships all repositories together from Pi Desktop.',
    `</${REPO_MAP_PROMPT_TAG}>`,
  ].join('\n')
}

function sameCheckout(a: RepoMapEntry, b: RepoMapEntry): boolean {
  return a.name === b.name && a.workPath === b.workPath
}

/**
 * The note for the agent when the repositories changed since its last turn,
 * or null when they did not. A quiet change to the system prompt is not
 * enough: a model trusts its own earlier answer about the repositories over
 * an updated instruction, so the change is also said in the conversation.
 */
export function describeRepoSetChange(previous: RepoSetContext, current: RepoSetContext): string | null {
  const added = current.repos.filter((repo) => !previous.repos.some((old) => sameCheckout(old, repo)))
  const removed = previous.repos.filter((old) => !current.repos.some((repo) => sameCheckout(old, repo)))
  if (added.length === 0 && removed.length === 0) return null
  return [
    'The repositories of this linked task changed. The list in your system instructions is now current.',
    ...added.map((repo) => `Added: ${repo.name} at ${repo.workPath} (${repo.branch ? `branch ${repo.branch}` : 'detached HEAD'}). Include it in the task from now on.`),
    ...removed.map((repo) => `Removed: ${repo.name} at ${repo.workPath}. Do not edit it any more.`),
  ].join('\n')
}

/**
 * Append a block to the system prompt a `before_agent_start` handler received.
 * Pi passes one string; OMP passes a list of strings. The result keeps the
 * engine's own shape.
 */
export function appendToSystemPrompt(systemPrompt: string | readonly string[], block: string): string | string[] {
  if (typeof systemPrompt === 'string') return `${systemPrompt}\n\n${block}`
  return [...systemPrompt, block]
}
