import { existsSync } from 'fs'
import { copyFile, mkdir, readFile, rename, writeFile } from 'fs/promises'
import { basename, dirname, resolve } from 'path'
import type { RepoFolderInfo, RepoSet, RepoSetDraft, RepoSetMember } from '../shared/ipc-contracts'
import { pathGroupKey } from '../shared/path-compare'
import { describeRepoSetDraftProblem, repoSetDraftProblem } from '../shared/repo-set-draft'
import { t } from '../shared/i18n'
import { getGuiDataPath } from './app-data-paths'
import { appLog } from './app-log'
import { inspectGitRepository, isMissingRepositoryError, runGit } from './git-worktree'

const REPO_SETS_FILE = 'repo-sets.json'
const REPO_SETS_FILE_VERSION = 1

interface RepoSetsFile {
  version: typeof REPO_SETS_FILE_VERSION
  sets: RepoSet[]
}

function isRepoSetMember(value: unknown): value is RepoSetMember {
  const member = value as Partial<RepoSetMember> | null
  return !!member && typeof member.name === 'string' && typeof member.sourcePath === 'string' &&
    (member.role === 'main' || member.role === 'linked')
}

function isRepoSet(value: unknown): value is RepoSet {
  const set = value as Partial<RepoSet> | null
  return !!set && typeof set.id === 'string' && typeof set.name === 'string' &&
    typeof set.createdAt === 'number' && typeof set.updatedAt === 'number' &&
    Array.isArray(set.members) && set.members.every(isRepoSetMember)
}

/**
 * Resolve a picked folder to the top of its git checkout. A folder inside a
 * repository counts as that repository, so a set never holds half a checkout.
 */
export async function inspectRepoFolder(path: string): Promise<RepoFolderInfo> {
  if (!existsSync(path)) throw new Error(t('repoSets.errors.folderMissing', { path }))
  try {
    const top = (await runGit(['rev-parse', '--show-toplevel'], path)).stdout.trim()
    return { path: resolve(top), name: basename(top) }
  } catch (error) {
    if (isMissingRepositoryError(error)) throw new Error(t('repoSets.errors.notGitRepository', { path }), { cause: error })
    throw error
  }
}

/**
 * Check a draft against the shared set rules and normalize it (trimmed
 * names), then reject a folder listed two times. Folder checks against git
 * happen in `resolveRepoSetDraft`.
 */
export function validateRepoSetDraft(draft: RepoSetDraft): RepoSetDraft {
  const name = draft.name.trim()
  const members = draft.members.map((member) => ({ ...member, name: member.name.trim() }))
  const problem = repoSetDraftProblem(name, members)
  if (problem) throw new Error(describeRepoSetDraftProblem(problem))
  const folders = new Set<string>()
  for (const member of members) {
    const folderKey = pathGroupKey(resolve(member.sourcePath))
    if (folders.has(folderKey)) throw new Error(t('repoSets.errors.duplicateFolder', { path: member.sourcePath }))
    folders.add(folderKey)
  }
  return { ...(draft.id ? { id: draft.id } : {}), name, members }
}

/**
 * Validate a draft against git: every folder resolves to a checkout, and no
 * two members are checkouts of one repository (a linked task gives every
 * member a branch of the same name, which one repository cannot hold twice).
 */
export async function resolveRepoSetDraft(draft: RepoSetDraft): Promise<RepoSetDraft> {
  const checked = validateRepoSetDraft(draft)
  const repositories = new Set<string>()
  const members: RepoSetMember[] = []
  for (const member of checked.members) {
    const folder = await inspectRepoFolder(member.sourcePath)
    const { repoRoot } = await inspectGitRepository(folder.path)
    const repositoryKey = pathGroupKey(resolve(repoRoot))
    if (repositories.has(repositoryKey)) throw new Error(t('repoSets.errors.sameRepository', { name: member.name }))
    repositories.add(repositoryKey)
    members.push({ ...member, sourcePath: folder.path })
  }
  return validateRepoSetDraft({ ...checked, members })
}

/** Saved repo sets, persisted in the GUI data directory. */
export class RepoSetStore {
  private sets: RepoSet[] | null = null

  constructor(private readonly filePath: string = getGuiDataPath(REPO_SETS_FILE)) {}

  async list(): Promise<RepoSet[]> {
    return [...(await this.load())].sort((a, b) => a.name.localeCompare(b.name))
  }

  async get(id: string): Promise<RepoSet> {
    const set = (await this.load()).find((item) => item.id === id)
    if (!set) throw new Error(t('repoSets.errors.notFound'))
    return set
  }

  async save(draft: RepoSetDraft): Promise<RepoSet> {
    const resolved = await resolveRepoSetDraft(draft)
    const sets = await this.load()
    const now = Date.now()
    const existing = resolved.id ? sets.find((item) => item.id === resolved.id) : undefined
    if (resolved.id && !existing) throw new Error(t('repoSets.errors.notFound'))
    const saved: RepoSet = existing
      ? { ...existing, name: resolved.name, members: resolved.members, updatedAt: now }
      : {
        id: `rs-${now}-${Math.random().toString(36).slice(2, 8)}`,
        name: resolved.name,
        members: resolved.members,
        createdAt: now,
        updatedAt: now,
      }
    this.sets = existing ? sets.map((item) => item.id === saved.id ? saved : item) : [...sets, saved]
    await this.persist()
    return saved
  }

  async delete(id: string): Promise<void> {
    const sets = await this.load()
    this.sets = sets.filter((item) => item.id !== id)
    await this.persist()
  }

  private async load(): Promise<RepoSet[]> {
    if (this.sets) return this.sets
    this.sets = (await this.read(this.filePath)) ?? (await this.read(`${this.filePath}.bak`)) ?? []
    return this.sets
  }

  private async read(path: string): Promise<RepoSet[] | null> {
    try {
      if (!existsSync(path)) return null
      const parsed = JSON.parse(await readFile(path, 'utf-8')) as Partial<RepoSetsFile> | null
      if (!parsed || !Array.isArray(parsed.sets)) return null
      return parsed.sets.filter(isRepoSet)
    } catch {
      return null
    }
  }

  /** Atomic write with a backup of the last good file, like workspaces.json. */
  private async persist(): Promise<void> {
    const file: RepoSetsFile = { version: REPO_SETS_FILE_VERSION, sets: this.sets ?? [] }
    try {
      await mkdir(dirname(this.filePath), { recursive: true })
      if (existsSync(this.filePath)) await copyFile(this.filePath, `${this.filePath}.bak`)
      const tmpPath = `${this.filePath}.tmp`
      await writeFile(tmpPath, JSON.stringify(file, null, 2), 'utf-8')
      await rename(tmpPath, this.filePath)
    } catch (error) {
      appLog.error('repo-sets', 'Failed to save repo-sets.json', error)
      throw error
    }
  }
}
