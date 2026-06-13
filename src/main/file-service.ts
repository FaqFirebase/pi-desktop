import { watch, type FSWatcher } from 'chokidar'
import { readdir, stat, readFile, writeFile } from 'fs/promises'
import { join, extname, basename, resolve, relative } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { describeWriteError } from './fs-errors'
import type { FileChangeEvent } from '../shared/ipc-contracts'

const execFileAsync = promisify(execFile)

/**
 * File system service for the workspace.
 * Provides: file tree, file search, git status, file watching.
 */

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'out',
  '.cache', '__pycache__', '.venv', 'venv', '.tox',
  'target', 'coverage', '.nyc_output',
])

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
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private pendingChange: FileChangeEvent | null = null

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath
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
   * Get git status for the workspace.
   */
  async getGitStatus(): Promise<Map<string, GitFileStatus>> {
    const statusMap = new Map<string, GitFileStatus>()

    try {
      const { stdout } = await execFileAsync('git', ['status', '--porcelain=v1', '-u'], {
        cwd: this.workspacePath,
        timeout: 10_000,
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
    } catch {
      // Not a git repo or git not available
    }

    return statusMap
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
   * Get a diff for a specific file.
   */
  async getFileDiff(filePath?: string): Promise<string> {
    try {
      const args = ['diff']
      if (filePath) args.push(filePath)
      const { stdout } = await execFileAsync('git', args, {
        cwd: this.workspacePath,
        timeout: 10_000,
      })
      const untrackedDiff = await this.getUntrackedFileDiff(filePath)
      return [stdout, untrackedDiff].filter((part) => part.trim()).join('\n')
    } catch {
      return ''
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
   * Get the staged diff.
   */
  async getStagedDiff(filePath?: string): Promise<string> {
    try {
      const args = ['diff', '--cached']
      if (filePath) args.push(filePath)
      const { stdout } = await execFileAsync('git', args, {
        cwd: this.workspacePath,
        timeout: 10_000,
      })
      return stdout
    } catch {
      return ''
    }
  }

  /**
   * Read a file's content (for preview).
   */
  async readFileContent(filePath: string): Promise<string> {
    const fullPath = filePath.startsWith('/') ? filePath : join(this.workspacePath, filePath)
    return readFile(fullPath, 'utf-8')
  }

  async writeFileContent(filePath: string, content: string): Promise<void> {
    const fullPath = filePath.startsWith('/') ? filePath : join(this.workspacePath, filePath)
    const resolvedWorkspace = resolve(this.workspacePath)
    const resolvedFile = resolve(fullPath)
    const rel = relative(resolvedWorkspace, resolvedFile)

    if (rel.startsWith('..') || rel === '') {
      throw new Error('Refusing to write outside the active workspace')
    }

    try {
      await writeFile(resolvedFile, content, 'utf-8')
    } catch (err) {
      // Turn opaque EPERM/EACCES into a Controlled Folder Access hint on Windows.
      throw describeWriteError(err, resolvedFile)
    }
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
      // Tolerate watch failures (e.g. inotify limit ENOSPC on large trees):
      // the renderer's safety-net poll still keeps the tree fresh.
      .on('error', (err) => console.error('[FileService] watch error:', err))
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
    return rel.split(/[\\/]/).some((segment) => IGNORED_DIRS.has(segment))
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
            .filter((item) => !IGNORED_DIRS.has(item.name) && !item.name.startsWith('.git'))
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

      for (const item of items) {
        if (IGNORED_DIRS.has(item.name) || item.name.startsWith('.git')) continue

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
