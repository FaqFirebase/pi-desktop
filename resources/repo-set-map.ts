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
import { join, resolve } from 'node:path'
import { isPathWithin } from './path-within'
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

/**
 * The repository whose checkout holds `path` (relative paths resolve against
 * `cwd`, the agent's working directory). The deepest checkout wins, so a
 * worktree nested under another repository's folder still maps to itself.
 */
export function repoForPath(context: RepoSetContext, path: string, cwd: string): RepoMapEntry | null {
  const absolute = resolve(cwd, path)
  let best: RepoMapEntry | null = null
  for (const repo of context.repos) {
    if (!isPathWithin(repo.workPath, absolute)) continue
    if (!best || resolve(repo.workPath).length > resolve(best.workPath).length) best = repo
  }
  return best
}

/** Tools whose `path` input names a file they create or change (Pi and OMP). */
const FILE_WRITE_TOOLS = new Set(['edit', 'write', 'ast_edit'])

/**
 * A file write that lands outside every checkout of the task. It is never
 * blocked, only routed to the normal approval prompt, so the user decides.
 * Shell commands are not inspected for paths on purpose (owner decision,
 * 2026-10-09): parsing them gives false prompts, and the permission mode and
 * rules already govern them.
 */
export function isWriteOutsideRepoSet(context: RepoSetContext, toolName: string, input: unknown, cwd: string): boolean {
  if (!FILE_WRITE_TOOLS.has(toolName)) return false
  const primary = getPrimaryInput(toolName, input)
  return primary.kind === 'path' && repoForPath(context, primary.value, cwd) === null
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
