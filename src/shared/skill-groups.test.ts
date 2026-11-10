import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { InstalledSkill } from './ipc-contracts'
import {
  SKILL_GROUP_NAME_MAX_LENGTH,
  addSkillGroup,
  arrangeSkills,
  assignSkillToGroup,
  cleanSkillGroupName,
  moveSkillGroup,
  normalizeSkillGroups,
  removeSkillGroup,
  renameSkillGroup,
  skillGroupIdOf,
  toggleSkillGroupCollapsed,
  type SkillGroup,
} from './skill-groups'

function skill(name: string, description = ''): InstalledSkill {
  return { name, description, path: `/skills/${name}/SKILL.md`, source: 'global', enabled: true }
}

function group(id: string, skills: string[] = [], collapsed = false): SkillGroup {
  return { id, name: id.toUpperCase(), skills, collapsed }
}

test('group names are trimmed, limited in length, and never blank', () => {
  assert.equal(cleanSkillGroupName('  Writing  '), 'Writing')
  assert.equal(cleanSkillGroupName('   '), null)
  assert.equal(cleanSkillGroupName('x'.repeat(SKILL_GROUP_NAME_MAX_LENGTH + 5))?.length, SKILL_GROUP_NAME_MAX_LENGTH)
})

test('normalizeSkillGroups keeps valid groups and drops what no build writes', () => {
  const groups = normalizeSkillGroups([
    { id: 'a', name: ' Git ', skills: ['commit', 42, ''], collapsed: true },
    { id: 'a', name: 'Duplicate id', skills: [] },
    { id: 'b', name: '  ', skills: [] },
    { id: '', name: 'No id', skills: [] },
    'not a group',
    { id: 'c', name: 'Docs', skills: 'not a list', collapsed: 'yes' },
  ])
  assert.deepEqual(groups, [
    { id: 'a', name: 'Git', skills: ['commit'], collapsed: true },
    { id: 'c', name: 'Docs', skills: [], collapsed: false },
  ])
  assert.deepEqual(normalizeSkillGroups(undefined), [])
  assert.deepEqual(normalizeSkillGroups({}), [])
})

test('normalizeSkillGroups keeps a skill only in its first group', () => {
  const groups = normalizeSkillGroups([
    { id: 'a', name: 'A', skills: ['shared'] },
    { id: 'b', name: 'B', skills: ['shared', 'own'] },
  ])
  assert.deepEqual(groups.map((g) => g.skills), [['shared'], ['own']])
})

test('addSkillGroup appends an empty expanded group and refuses a blank name or a used id', () => {
  const added = addSkillGroup([], 'a', ' Writing ')
  assert.deepEqual(added, [{ id: 'a', name: 'Writing', skills: [], collapsed: false }])
  assert.deepEqual(addSkillGroup(added, 'b', '  '), added)
  assert.deepEqual(addSkillGroup(added, 'a', 'Other'), added)
})

test('renameSkillGroup changes only the named group and ignores a blank name', () => {
  const groups = [group('a'), group('b')]
  assert.deepEqual(renameSkillGroup(groups, 'b', ' New ').map((g) => g.name), ['A', 'New'])
  assert.deepEqual(renameSkillGroup(groups, 'b', ' '), groups)
})

test('removeSkillGroup removes the group and leaves the others', () => {
  assert.deepEqual(removeSkillGroup([group('a', ['x']), group('b')], 'a'), [group('b')])
})

test('moveSkillGroup swaps with the neighbor and stops at the ends', () => {
  const groups = [group('a'), group('b'), group('c')]
  assert.deepEqual(moveSkillGroup(groups, 'b', -1).map((g) => g.id), ['b', 'a', 'c'])
  assert.deepEqual(moveSkillGroup(groups, 'b', 1).map((g) => g.id), ['a', 'c', 'b'])
  assert.deepEqual(moveSkillGroup(groups, 'a', -1), groups)
  assert.deepEqual(moveSkillGroup(groups, 'c', 1), groups)
  assert.deepEqual(moveSkillGroup(groups, 'missing', 1), groups)
})

test('toggleSkillGroupCollapsed flips only the named group', () => {
  const toggled = toggleSkillGroupCollapsed([group('a'), group('b')], 'a')
  assert.deepEqual(toggled.map((g) => g.collapsed), [true, false])
})

test('assignSkillToGroup moves a skill between groups and out of all groups', () => {
  const groups = [group('a', ['x']), group('b')]
  const moved = assignSkillToGroup(groups, 'x', 'b')
  assert.deepEqual(moved.map((g) => g.skills), [[], ['x']])
  assert.equal(skillGroupIdOf(moved, 'x'), 'b')
  const ungrouped = assignSkillToGroup(moved, 'x', null)
  assert.deepEqual(ungrouped.map((g) => g.skills), [[], []])
  assert.equal(skillGroupIdOf(ungrouped, 'x'), null)
})

test('arrangeSkills puts grouped skills in group order and keeps the rest ungrouped', () => {
  const skills = [skill('commit'), skill('review'), skill('docs')]
  const groups = [group('git', ['review', 'commit', 'uninstalled']), group('empty')]
  const arranged = arrangeSkills(skills, groups, '')
  assert.deepEqual(
    arranged.groups.map((entry) => [entry.group.id, entry.skills.map((s) => s.name)]),
    [['git', ['commit', 'review']], ['empty', []]]
  )
  assert.deepEqual(arranged.ungrouped.map((s) => s.name), ['docs'])
})

test('arrangeSkills search matches every token in name or description and hides groups with no match', () => {
  const skills = [skill('commit', 'Write a git commit message'), skill('docs', 'Write documentation')]
  const groups = [group('git', ['commit']), group('empty')]
  const arranged = arrangeSkills(skills, groups, '  GIT write ')
  assert.deepEqual(arranged.groups.map((entry) => entry.group.id), ['git'])
  assert.deepEqual(arranged.groups[0].skills.map((s) => s.name), ['commit'])
  assert.deepEqual(arranged.ungrouped, [])
})
