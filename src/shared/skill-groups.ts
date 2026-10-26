import type { InstalledSkill } from './ipc-contracts'
import { matchesSearchTokens, searchTokens } from './package-filter'

/**
 * User-made skill groups for the Skills panel. They are a display setting
 * only: a group holds skill names, and no skill file or folder is ever moved
 * or changed. Names are the key because both engines run a skill by name
 * (`/skill:<name>`). A name whose skill is not listed now (the other engine's
 * skill, an uninstalled one) stays in its group, so switching engines keeps
 * the layout.
 */
export interface SkillGroup {
  id: string
  name: string
  /** Skill names in this group. A skill belongs to one group at most. */
  skills: string[]
  collapsed: boolean
}

export const SKILL_GROUP_NAME_MAX_LENGTH = 60

export type SkillGroupMoveDirection = -1 | 1

export interface ArrangedSkillGroup {
  group: SkillGroup
  skills: InstalledSkill[]
}

export interface ArrangedSkills {
  groups: ArrangedSkillGroup[]
  ungrouped: InstalledSkill[]
}

/** The trimmed, length-limited group name, or null when nothing is left. */
export function cleanSkillGroupName(name: string): string | null {
  const trimmed = name.trim().slice(0, SKILL_GROUP_NAME_MAX_LENGTH).trim()
  return trimmed || null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read skill groups from a settings file. Entries no build writes (hand
 * edits, other versions) are dropped, and a skill listed in more than one
 * group stays only in the first.
 */
export function normalizeSkillGroups(value: unknown): SkillGroup[] {
  if (!Array.isArray(value)) return []
  const ids = new Set<string>()
  const grouped = new Set<string>()
  const groups: SkillGroup[] = []
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id)) continue
    const name = typeof entry.name === 'string' ? cleanSkillGroupName(entry.name) : null
    if (!name) continue
    const skills = (Array.isArray(entry.skills) ? entry.skills : []).filter(
      (skill): skill is string => typeof skill === 'string' && skill !== '' && !grouped.has(skill)
    )
    for (const skill of skills) grouped.add(skill)
    ids.add(entry.id)
    groups.push({ id: entry.id, name, skills, collapsed: entry.collapsed === true })
  }
  return groups
}

export function addSkillGroup(groups: readonly SkillGroup[], id: string, name: string): SkillGroup[] {
  const cleanName = cleanSkillGroupName(name)
  if (!cleanName || groups.some((group) => group.id === id)) return [...groups]
  return [...groups, { id, name: cleanName, skills: [], collapsed: false }]
}

export function renameSkillGroup(groups: readonly SkillGroup[], id: string, name: string): SkillGroup[] {
  const cleanName = cleanSkillGroupName(name)
  if (!cleanName) return [...groups]
  return groups.map((group) => (group.id === id ? { ...group, name: cleanName } : group))
}

/** Removes the group only; its skills go back to the ungrouped list. */
export function removeSkillGroup(groups: readonly SkillGroup[], id: string): SkillGroup[] {
  return groups.filter((group) => group.id !== id)
}

export function moveSkillGroup(
  groups: readonly SkillGroup[],
  id: string,
  direction: SkillGroupMoveDirection
): SkillGroup[] {
  const from = groups.findIndex((group) => group.id === id)
  const to = from + direction
  if (from < 0 || to < 0 || to >= groups.length) return [...groups]
  const next = [...groups]
  ;[next[from], next[to]] = [next[to], next[from]]
  return next
}

export function toggleSkillGroupCollapsed(groups: readonly SkillGroup[], id: string): SkillGroup[] {
  return groups.map((group) => (group.id === id ? { ...group, collapsed: !group.collapsed } : group))
}

/** Puts the skill in the group (null: in no group), taking it out of any other group. */
export function assignSkillToGroup(
  groups: readonly SkillGroup[],
  skillName: string,
  groupId: string | null
): SkillGroup[] {
  return groups.map((group) => {
    const skills = group.skills.filter((skill) => skill !== skillName)
    if (group.id === groupId) skills.push(skillName)
    return skills.length === group.skills.length && group.id !== groupId ? group : { ...group, skills }
  })
}

export function skillGroupIdOf(groups: readonly SkillGroup[], skillName: string): string | null {
  return groups.find((group) => group.skills.includes(skillName))?.id ?? null
}

/**
 * Sort the listed skills into the user's groups, in group order, keeping the
 * listed order inside each group. A search query keeps only the skills whose
 * name or description has every query token, and then hides groups with no
 * match.
 */
export function arrangeSkills(
  skills: readonly InstalledSkill[],
  groups: readonly SkillGroup[],
  query: string
): ArrangedSkills {
  const tokens = searchTokens(query)
  const visible = tokens.length === 0
    ? skills
    : skills.filter((skill) => matchesSearchTokens(`${skill.name} ${skill.description}`, tokens))

  const groupIdBySkill = new Map<string, string>()
  for (const group of groups) {
    for (const skill of group.skills) groupIdBySkill.set(skill, group.id)
  }

  const skillsByGroup = new Map<string, InstalledSkill[]>(groups.map((group) => [group.id, []]))
  const ungrouped: InstalledSkill[] = []
  for (const skill of visible) {
    const groupId = groupIdBySkill.get(skill.name)
    if (groupId) skillsByGroup.get(groupId)!.push(skill)
    else ungrouped.push(skill)
  }

  const arranged = groups.map((group) => ({ group, skills: skillsByGroup.get(group.id)! }))
  return {
    groups: tokens.length === 0 ? arranged : arranged.filter((entry) => entry.skills.length > 0),
    ungrouped,
  }
}
