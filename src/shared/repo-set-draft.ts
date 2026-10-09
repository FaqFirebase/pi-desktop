import type { RepoFolderInfo, RepoSetMember } from './ipc-contracts'
import { t } from './i18n'

/** A set of one repository is just a normal tab. */
export const MIN_REPO_SET_MEMBERS = 2

/** `name`, or `name-2`, `name-3`... when one of `taken` already uses it (case-insensitive). */
export function uniqueRepoName(name: string, taken: readonly string[]): string {
  const used = new Set(taken.map((item) => item.toLowerCase()))
  if (!used.has(name.toLowerCase())) return name
  let suffix = 2
  while (used.has(`${name}-${suffix}`.toLowerCase())) suffix++
  return `${name}-${suffix}`
}

/** Add a picked checkout; the first repository of a set is its main one. */
export function addRepoSetMember(members: readonly RepoSetMember[], folder: RepoFolderInfo): RepoSetMember[] {
  return [...members, {
    name: uniqueRepoName(folder.name, members.map((member) => member.name)),
    sourcePath: folder.path,
    role: members.length === 0 ? 'main' : 'linked',
  }]
}

/** Remove one repository; when it was the main one, the first that is left takes over. */
export function removeRepoSetMember(members: readonly RepoSetMember[], index: number): RepoSetMember[] {
  const left = members.filter((_, position) => position !== index)
  if (left.length === 0 || left.some((member) => member.role === 'main')) return left
  return left.map((member, position) => ({ ...member, role: position === 0 ? 'main' : 'linked' }))
}

export function setMainRepoSetMember(members: readonly RepoSetMember[], index: number): RepoSetMember[] {
  return members.map((member, position) => ({ ...member, role: position === index ? 'main' : 'linked' }))
}

export function renameRepoSetMember(members: readonly RepoSetMember[], index: number, name: string): RepoSetMember[] {
  return members.map((member, position) => position === index ? { ...member, name } : member)
}

export type RepoSetDraftProblem =
  | { code: 'nameRequired' }
  | { code: 'tooFewRepositories' }
  | { code: 'repositoryNameRequired' }
  | { code: 'duplicateName'; name: string }
  | { code: 'oneMainRepository' }

/**
 * The first rule a draft breaks, or null when it can be saved: a set name, at
 * least two repositories, a unique name for each, and one main repository.
 * The main process checks the folders against git on top of this.
 */
export function repoSetDraftProblem(name: string, members: readonly RepoSetMember[]): RepoSetDraftProblem | null {
  if (!name.trim()) return { code: 'nameRequired' }
  if (members.length < MIN_REPO_SET_MEMBERS) return { code: 'tooFewRepositories' }
  const seen = new Set<string>()
  for (const member of members) {
    const memberName = member.name.trim()
    if (!memberName) return { code: 'repositoryNameRequired' }
    if (seen.has(memberName.toLowerCase())) return { code: 'duplicateName', name: memberName }
    seen.add(memberName.toLowerCase())
  }
  if (members.filter((member) => member.role === 'main').length !== 1) return { code: 'oneMainRepository' }
  return null
}

export function describeRepoSetDraftProblem(problem: RepoSetDraftProblem): string {
  switch (problem.code) {
    case 'nameRequired': return t('repoSets.errors.nameRequired')
    case 'tooFewRepositories': return t('repoSets.errors.tooFewRepositories', { minimum: MIN_REPO_SET_MEMBERS })
    case 'repositoryNameRequired': return t('repoSets.errors.repositoryNameRequired')
    case 'duplicateName': return t('repoSets.errors.duplicateName', { name: problem.name })
    case 'oneMainRepository': return t('repoSets.errors.oneMainRepository')
  }
}
