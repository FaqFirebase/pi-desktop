import { watch, type FSWatcher } from 'chokidar'
import { readdir, stat, readFile, writeFile, realpath } from 'fs/promises'
import { join, extname, basename, resolve, relative, isAbsolute, sep, dirname } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { homedir } from 'os'
import { describeWriteError } from './fs-errors'
import { appLog } from './app-log'
import type { FileChangeEvent } from '../shared/ipc-contracts'
import { i18n, t, tEnglish, type Translate } from '../shared/i18n'

const execFileAsync = promisify(execFile)

// execFile kills the child past 1 MiB of stdout by default, which a
// whole-worktree status or diff on a repo with many changes easily exceeds.
const GIT_OUTPUT_MAX_BUFFER_BYTES = 64 * 1024 * 1024

const PARENT_ESCAPE = '..'

const WORKSPACE_ESCAPE_KEYS = {
  read: 'errors.fileService.refusedRead',
  write: 'errors.fileService.refusedWrite',
} as const satisfies Record<'read' | 'write', string>

const NOT_GIT_REPO_RE = /not a git repository/i
// Bare repos: rev-parse succeeds but status/diff refuse to run.
const NO_WORK_TREE_RE = /must be run in a work tree/i

/**
 * True for git errors that just mean "no git information here": the workspace
 * is not a repo (or a bare one), or the machine has no git binary. All are
 * normal configurations and must keep producing empty results, not errors.
 */
export function isBenignGitError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const { code, stderr, message } = err as { code?: unknown; stderr?: unknown; message?: unknown }
  if (code === 'ENOENT') return true
  const text = `${typeof stderr === 'string' ? stderr : ''} ${typeof message === 'string' ? message : ''}`
  return NOT_GIT_REPO_RE.test(text) || NO_WORK_TREE_RE.test(text)
}

/**
 * Compact failure text for a git subcommand: first stderr line, else message.
 * `t` defaults to the interface language; the log passes `tEnglish`.
 */
export function describeGitError(operation: string, err: unknown, t: Translate = i18n.t): string {
  const { stderr, message } = (err ?? {}) as { stderr?: unknown; message?: unknown }
  const stderrLine = typeof stderr === 'string' ? stderr.trim().split('\n')[0] : ''
  const detail = stderrLine || (typeof message === 'string' ? message : String(err))
  return t('errors.git.commandFailedWithDetail', { command: `git ${operation}`, detail })
}

// One log entry per workspace+operation per run — git status is polled every
// few seconds, so an unguarded log would flood the file.
const gitErrorLogged = new Set<string>()

/**
 * True when `filePath` (absolute or workspace-relative) resolves to a location
 * strictly inside `workspacePath`. Pure and synchronous; covers parent-directory
 * traversal and Windows cross-drive paths. Symlink escapes are checked
 * separately via realpath in the read/write paths.
 */
export function isPathInsideWorkspace(workspacePath: string, filePath: string): boolean {
  const fullPath = isAbsolute(filePath) ? filePath : join(workspacePath, filePath)
  const rel = relative(resolve(workspacePath), resolve(fullPath))
  return (
    rel !== '' &&
    rel !== PARENT_ESCAPE &&
    !rel.startsWith(PARENT_ESCAPE + sep) &&
    !isAbsolute(rel)
  )
}

/**
 * Real path of the deepest existing ancestor of `p`, with the still-missing tail
 * re-appended. Lets us resolve symlinks even when the target file does not exist
 * yet (e.g. writing a new file into a real directory).
 */
async function realpathDeepest(p: string): Promise<string> {
  let current = resolve(p)
  const tail: string[] = []
  for (;;) {
    try {
      const real = await realpath(current)
      return tail.length ? resolve(real, ...tail.reverse()) : real
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      const parent = dirname(current)
      if (parent === current) return resolve(p)
      tail.push(basename(current))
      current = parent
    }
  }
}

/**
 * File system service for the workspace.
 * Provides: file tree, file search, git status, file watching.
 */

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'out',
  '.cache', '__pycache__', '.venv', 'venv', '.tox',
  'target', 'coverage', '.nyc_output',
])

/**
 * Package caches and tool state that live under a home-directory workspace.
 * Each holds thousands of directories, so watching them exhausts file
 * descriptors long before `WATCH_DEPTH` bounds the walk.
 */
const HOME_TOOLING_IGNORED = new Set([
  '.npm', '.pnpm-store', '.yarn', '.bun', '.nvm', '.cargo', '.rustup',
  '.gradle', '.m2', '.local', '.docker', '.codex', '.gemini', '.Trash',
])

/**
 * macOS keeps application state in `~/Library`, the largest tree in a home
 * directory. Only applied on darwin so a project folder named `Library`
 * elsewhere is still watched.
 */
const DARWIN_HOME_IGNORED = new Set(['Library'])

/**
 * Windows user-profile folders that appear under a home-directory workspace.
 * Watching them hits junctions / protected reparse points (EPERM noise).
 * Only applied on win32 so other platforms are unaffected.
 */
const WIN32_PROFILE_IGNORED = new Set([
  'appdata',
  'application data',
  'local settings',
  'cookies',
  'recent',
  'sendto',
  'start menu',
  'templates',
  'nethood',
  'printhood',
  'my documents',
  'my music',
  'my pictures',
  'my videos',
])

/**
 * True when a directory name is skipped in every workspace by the watcher,
 * the tree view, and file search.
 */
export function isIgnoredDirName(name: string): boolean {
  return IGNORED_DIRS.has(name)
}

/**
 * True when a directory directly under a home-directory workspace is skipped.
 * Project folders can share these names (`.cargo`, `templates`), so the sets
 * never apply to other workspaces or to nested paths. Platform-specific sets
 * only apply on their own platform.
 */
export function isIgnoredHomeRootDirName(name: string, platform: NodeJS.Platform = process.platform): boolean {
  if (HOME_TOOLING_IGNORED.has(name)) return true
  if (platform === 'darwin') return DARWIN_HOME_IGNORED.has(name)
  if (platform !== 'win32') return false
  const lower = name.toLowerCase()
  return WIN32_PROFILE_IGNORED.has(lower) || lower.startsWith('ntuser.')
}

const WORKSPACE_ROOT_DEPTH = 0

/** Log each watch error path at most once to avoid console floods. */
const watchErrorLogged = new Set<string>()

// Watcher tuning. Depth matches the tree view (getFileTree default), so the
// watcher never recurses into deep subtrees the UI doesn't render — important
// because the default workspace is the user's home directory. Burst writes
// (e.g. an agent editing several files) are coalesced into one refresh.
const WATCH_DEPTH = 4
const WATCH_DEBOUNCE_MS = 250

export type FileChangeCallback = (event: FileChangeEvent) => void

const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.mdx', '.txt',
  '.html', '.css', '.scss', '.less', '.yaml', '.yml', '.toml',
  '.xml', '.svg', '.py', '.rb', '.go', '.rs', '.java', '.c',
  '.cpp', '.h', '.hpp', '.cs', '.swift', '.kt', '.sh', '.bash',
  '.zsh', '.fish', '.env', '.gitignore', '.dockerignore',
  '.prettierrc', '.eslintrc', 'Makefile', 'Dockerfile',
])

export interface FileTreeNode {
  name: string
  path: string
  relativePath: string
  type: 'file' | 'directory'
  children?: FileTreeNode[]
  gitStatus?: GitFileStatus
}

export interface GitFileStatus {
  index: string // staged status (M, A, D, R, C, ?)
  worktree: string // working tree status
  isStaged: boolean
}

export interface SearchResult {
  path: string
  relativePath: string
  name: string
  matchType: 'filename' | 'content'
  line?: number
  snippet?: string
}

export function buildNewFileDiff(relativePath: string, content: string): string {
  const lines = content.endsWith('\n') ? content.slice(0, -1).split('\n') : content.split('\n')
  const hunkSize = lines.length

  return [
    `diff --git a/${relativePath} b/${relativePath}`,
    'new file mode 100644',
    'index 0000000..0000000',
    '--- /dev/null',
    `+++ b/${relativePath}`,
    `@@ -0,0 +1,${hunkSize} @@`,
    ...lines.map((line) => `+${line}`),
    '',
  ].join('\n')
}

export class FileService {
  private watcher: FSWatcher | null = null
  private workspacePath: string
  private readonly isHomeWorkspace: boolean
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private pendingChange: FileChangeEvent | null = null

  constructor(workspacePath: string, homePath: string = homedir()) {
    this.workspacePath = workspacePath
    this.isHomeWorkspace = resolve(workspacePath) === resolve(homePath)
  }

  /** True when an entry at `depth` below the workspace root must be skipped. */
  private isIgnoredEntry(name: string, depth: number): boolean {
    if (isIgnoredDirName(name)) return true
    return this.isHomeWorkspace && depth === WORKSPACE_ROOT_DEPTH && isIgnoredHomeRootDirName(name)
  }

  /**
   * Build a file tree for the workspace.
   */
  async getFileTree(maxDepth = 4): Promise<FileTreeNode> {
    return this.buildTree(this.workspacePath, '', 0, maxDepth)
  }

  /**
   * Search for files by name pattern.
   */
  async searchFiles(query: string, maxResults = 50): Promise<SearchResult[]> {
    const results: SearchResult[] = []
    const lowerQuery = query.toLowerCase()
    await this.walkFiles(this.workspacePath, '', async (fullPath, relPath, name) => {
      if (results.length >= maxResults) return
      if (name.toLowerCase().includes(lowerQuery)) {
        results.push({
          path: fullPath,
          relativePath: relPath,
          name,
          matchType: 'filename',
        })
      }
    })
    return results
  }

  /**
   * Search file contents for a text pattern.
   */
  async searchContent(query: string, maxResults = 30): Promise<SearchResult[]> {
    const results: SearchResult[] = []
    const lowerQuery = query.toLowerCase()

    await this.walkFiles(this.workspacePath, '', async (fullPath, relPath, name) => {
      if (results.length >= maxResults) return

      const ext = extname(name).toLowerCase()
      if (!TEXT_EXTENSIONS.has(ext) && !name.startsWith('.')) return

      try {
        const content = await readFile(fullPath, 'utf-8')
        const lines = content.split('\n')

        for (let i = 0; i < lines.length; i++) {
          if (results.length >= maxResults) break
          if (lines[i].toLowerCase().includes(lowerQuery)) {
            results.push({
              path: fullPath,
              relativePath: relPath,
              name,
              matchType: 'content',
              line: i + 1,
              snippet: lines[i].trim().slice(0, 200),
            })
            break // One match per file
          }
        }
      } catch {
        // Skip binary or unreadable files
      }
    })

    return results
  }

  /**
   * Get git status for the workspace. Empty for non-repos and machines
   * without git; throws on real git failures so callers can surface them.
   */
  async getGitStatus(): Promise<Map<string, GitFileStatus>> {
    const statusMap = new Map<string, GitFileStatus>()

    try {
      const { stdout } = await execFileAsync('git', ['status', '--porcelain=v1', '-u'], {
        cwd: this.workspacePath,
        timeout: 10_000,
        maxBuffer: GIT_OUTPUT_MAX_BUFFER_BYTES,
      })

      for (const line of stdout.split('\n')) {
        if (line.length < 4) continue

        const indexStatus = line[0]
        const worktreeStatus = line[1]
        const filePath = line.slice(3).trim()

        // Handle renamed files (R old -> new)
        const cleanPath = filePath.includes(' -> ') ? filePath.split(' -> ')[1] : filePath

        statusMap.set(cleanPath, {
          index: indexStatus,
          worktree: worktreeStatus,
          isStaged: indexStatus !== ' ' && indexStatus !== '?',
        })
      }
    } catch (err) {
      if (!isBenignGitError(err) && (await this.probeGitRepo()) !== 'outside') {
        throw this.describeAndLogGitError('status', err)
      }
    }

    return statusMap
  }

  private describeAndLogGitError(operation: string, err: unknown): Error {
    // The log stays English, so it (and its dedup key) uses the English text;
    // the returned error carries the interface-language text for the UI.
    const englishDescription = describeGitError(operation, err, tEnglish)
    // Dedup by error signature, not just operation, so a NEW failure mode for
    // the same command still reaches the log.
    const key = `${this.workspacePath}:${englishDescription}`
    if (!gitErrorLogged.has(key)) {
      gitErrorLogged.add(key)
      appLog.warn('git', `${englishDescription} (${this.workspacePath})`, err)
    }
    return new Error(describeGitError(operation, err))
  }

  // Some git subcommands fail outside a repo with errors that never mention
  // "not a git repository" (e.g. `diff --cached` becomes an unknown option in
  // no-index mode), so on the error path settle it definitively. Three-way:
  // a broken git (config errors, permissions) must NOT be mistaken for
  // "outside a repo" — that would silently mask real failures.
  private async probeGitRepo(): Promise<'inside' | 'outside' | 'broken'> {
    try {
      await execFileAsync('git', ['rev-parse', '--git-dir'], {
        cwd: this.workspacePath,
        timeout: 5_000,
      })
      return 'inside'
    } catch (err) {
      return isBenignGitError(err) ? 'outside' : 'broken'
    }
  }

  /**
   * Get the current git branch name.
   */
  async getGitBranch(): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('git', ['branch', '--show-current'], {
        cwd: this.workspacePath,
        timeout: 5_000,
      })
      return stdout.trim() || null
    } catch {
      return null
    }
  }

  /**
   * Get a diff for a specific file. Empty for non-repos and machines without
   * git; throws on real git failures so callers can surface them.
   */
  async getFileDiff(filePath?: string): Promise<string> {
    try {
      const args = ['diff']
      if (filePath) args.push(filePath)
      const { stdout } = await execFileAsync('git', args, {
        cwd: this.workspacePath,
        timeout: 10_000,
        maxBuffer: GIT_OUTPUT_MAX_BUFFER_BYTES,
      })
      const untrackedDiff = await this.getUntrackedFileDiff(filePath)
      return [stdout, untrackedDiff].filter((part) => part.trim()).join('\n')
    } catch (err) {
      if (isBenignGitError(err) || (await this.probeGitRepo()) === 'outside') return ''
      throw this.describeAndLogGitError('diff', err)
    }
  }

  private async getUntrackedFileDiff(filePath?: string): Promise<string> {
    const statusMap = await this.getGitStatus()
    const untrackedPaths = [...statusMap.entries()]
      .filter(([, status]) => status.index === '?' && status.worktree === '?')
      .map(([path]) => path)
      .filter((path) => !filePath || path === filePath)

    const diffs: string[] = []
    for (const path of untrackedPaths) {
      try {
        const content = await readFile(join(this.workspacePath, path), 'utf-8')
        diffs.push(buildNewFileDiff(path, content))
      } catch {
        // Skip unreadable or binary-like untracked files.
      }
    }

    return diffs.join('\n')
  }

  /**
   * Get the staged diff. Empty for non-repos and machines without git;
   * throws on real git failures so callers can surface them.
   */
  async getStagedDiff(filePath?: string): Promise<string> {
    try {
      const args = ['diff', '--cached']
      if (filePath) args.push(filePath)
      const { stdout } = await execFileAsync('git', args, {
        cwd: this.workspacePath,
        timeout: 10_000,
        maxBuffer: GIT_OUTPUT_MAX_BUFFER_BYTES,
      })
      return stdout
    } catch (err) {
      if (isBenignGitError(err) || (await this.probeGitRepo()) === 'outside') return ''
      throw this.describeAndLogGitError('staged diff', err)
    }
  }

  /**
   * Read a file's content (for preview).
   */
  async readFileContent(filePath: string): Promise<string> {
    const resolvedFile = await this.resolveInsideWorkspace(filePath, 'read')
    return readFile(resolvedFile, 'utf-8')
  }

  async writeFileContent(filePath: string, content: string): Promise<void> {
    const resolvedFile = await this.resolveInsideWorkspace(filePath, 'write')
    try {
      await writeFile(resolvedFile, content, 'utf-8')
    } catch (err) {
      // Turn opaque EPERM/EACCES into a Controlled Folder Access hint on Windows.
      throw describeWriteError(err, resolvedFile)
    }
  }

  /**
   * Resolve a caller-supplied path and confirm it stays inside the workspace,
   * rejecting parent-directory traversal, cross-drive paths, and symlink escapes.
   * Returns the absolute path to use.
   */
  private async resolveInsideWorkspace(filePath: string, action: 'read' | 'write'): Promise<string> {
    if (!isPathInsideWorkspace(this.workspacePath, filePath)) {
      throw new Error(t(WORKSPACE_ESCAPE_KEYS[action]))
    }
    const fullPath = isAbsolute(filePath) ? filePath : join(this.workspacePath, filePath)
    const resolvedFile = resolve(fullPath)
    // Symlink hardening: compare real paths so a symlink inside the workspace
    // that points outside it cannot be used to escape.
    const realWorkspace = await realpath(this.workspacePath)
    const realTarget = await realpathDeepest(resolvedFile)
    if (!isPathInsideWorkspace(realWorkspace, realTarget)) {
      throw new Error(t(WORKSPACE_ESCAPE_KEYS[action]))
    }
    return resolvedFile
  }

  /**
   * Start watching the workspace for file changes and invoke `callback`
   * (debounced) when files are added, changed, or removed. Heavy and hidden
   * directories are ignored, and recursion is bounded to `WATCH_DEPTH` so the
   * watcher stays cheap even when the workspace is the user's home directory.
   * Idempotent per instance: a second call replaces the previous watcher.
   */
  startWatching(callback: FileChangeCallback): void {
    this.stopWatching()

    this.watcher = watch(this.workspacePath, {
      ignored: (path) => this.isIgnoredPath(path),
      ignoreInitial: true,
      // Ignores are decided by the link name, not its target, so a followed
      // symlink can fan out into an unbounded tree (Windows junctions into
      // protected folders, POSIX links into package stores). Never follow.
      followSymlinks: false,
      depth: WATCH_DEPTH,
      awaitWriteFinish: { stabilityThreshold: WATCH_DEBOUNCE_MS, pollInterval: 50 },
      persistent: true,
    })

    const emit = (changeType: FileChangeEvent['changeType']) => (absolutePath: string): void => {
      this.pendingChange = { changeType, relativePath: relative(this.workspacePath, absolutePath) }
      if (this.debounceTimer) clearTimeout(this.debounceTimer)
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null
        const change = this.pendingChange
        this.pendingChange = null
        if (change) callback(change)
      }, WATCH_DEBOUNCE_MS)
    }

    this.watcher
      .on('add', emit('add'))
      .on('change', emit('change'))
      .on('unlink', emit('unlink'))
      .on('addDir', emit('addDir'))
      .on('unlinkDir', emit('unlinkDir'))
      // Tolerate watch failures (EPERM on Windows protected dirs, ENOSPC on
      // large trees): the renderer's safety-net poll still keeps the tree fresh.
      .on('error', (err: unknown) => {
        const code =
          err && typeof err === 'object' && 'code' in err
            ? String((err as { code?: unknown }).code ?? '')
            : ''
        if (code === 'EPERM' || code === 'EACCES' || code === 'ENOENT') {
          const key = `${this.workspacePath}:${code}`
          if (!watchErrorLogged.has(key)) {
            watchErrorLogged.add(key)
            console.warn(`[FileService] watch ${code} under ${this.workspacePath} (further ${code} suppressed)`)
          }
          return
        }
        console.error('[FileService] watch error:', err)
      })
  }

  /**
   * Stop watching and cancel any pending debounced change. Idempotent; callers
   * (workspace removal, app shutdown, re-watch) rely on it being safe to call
   * when no watcher is active.
   */
  stopWatching(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    this.pendingChange = null
    if (this.watcher) {
      void this.watcher.close()
      this.watcher = null
    }
  }

  /** True if any path segment under the workspace is an ignored directory. */
  private isIgnoredPath(absolutePath: string): boolean {
    const rel = relative(this.workspacePath, absolutePath)
    if (!rel || rel.startsWith('..')) return false
    return rel.split(/[\\/]/).some((segment, depth) => this.isIgnoredEntry(segment, depth))
  }

  /**
   * Check if a file is a text file (can be previewed).
   */
  isTextFile(filePath: string): boolean {
    const ext = extname(filePath).toLowerCase()
    return TEXT_EXTENSIONS.has(ext)
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private async buildTree(
    fullPath: string,
    relPath: string,
    depth: number,
    maxDepth: number
  ): Promise<FileTreeNode> {
    const name = relPath ? basename(fullPath) : basename(this.workspacePath)
    const fileStat = await stat(fullPath)

    if (fileStat.isDirectory()) {
      const children: FileTreeNode[] = []

      if (depth < maxDepth) {
        try {
          const items = await readdir(fullPath, { withFileTypes: true })

          // Sort: directories first, then files, both alphabetical
          const sorted = items
            .filter((item) => !this.isIgnoredEntry(item.name, depth) && !item.name.startsWith('.git'))
            .sort((a, b) => {
              if (a.isDirectory() && !b.isDirectory()) return -1
              if (!a.isDirectory() && b.isDirectory()) return 1
              return a.name.localeCompare(b.name)
            })

          for (const item of sorted) {
            const childPath = join(fullPath, item.name)
            const childRelPath = relPath ? `${relPath}/${item.name}` : item.name
            const child = await this.buildTree(childPath, childRelPath, depth + 1, maxDepth)
            children.push(child)
          }
        } catch {
          // Permission denied or similar
        }
      }

      return { name, path: fullPath, relativePath: relPath, type: 'directory', children }
    }

    return { name, path: fullPath, relativePath: relPath, type: 'file' }
  }

  private async walkFiles(
    dir: string,
    relBase: string,
    handler: (fullPath: string, relPath: string, name: string) => Promise<void>
  ): Promise<void> {
    try {
      const items = await readdir(dir, { withFileTypes: true })
      const depth = relBase ? relBase.split('/').length : WORKSPACE_ROOT_DEPTH

      for (const item of items) {
        if (this.isIgnoredEntry(item.name, depth) || item.name.startsWith('.git')) continue

        const fullPath = join(dir, item.name)
        const relPath = relBase ? `${relBase}/${item.name}` : item.name

        if (item.isDirectory()) {
          await this.walkFiles(fullPath, relPath, handler)
        } else if (item.isFile()) {
          await handler(fullPath, relPath, item.name)
        }
      }
    } catch {
      // Permission denied or similar
    }
  }
}
