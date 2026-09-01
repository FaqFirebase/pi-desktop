import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { RPC_SKILL_PATH_PREFIX, type InstalledSkill } from '../shared/ipc-contracts'
import { listSkills, mergeRpcSkills, parseSkillFrontmatter } from './skills-discovery'

const skillMd = (name: string): string => `---\nname: ${name}\ndescription: ${name} does things\n---\n\nBody.\n`

async function writeSkill(root: string, dirName: string, name = dirName): Promise<void> {
  const dir = join(root, dirName)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), skillMd(name), 'utf-8')
}

/**
 * A fixture tree holding skills in every per-engine root:
 *   home/.pi/agent/skills:  alpha, group/nested (recursive), note.md (bare)
 *   home/.omp/agent/skills: omp-global, group/omp-nested (must stay hidden)
 *   home/.claude/skills:    claude-global
 *   home/.agents/skills:    shared
 *   cwd/.pi/skills:         proj-pi
 *   cwd/.omp/skills:        proj-omp, claude-global (name collision)
 *   cwd/.claude/skills:     proj-claude
 */
async function withSkillTree<T>(fn: (home: string, cwd: string) => Promise<T>): Promise<T> {
  const base = await mkdtemp(join(tmpdir(), 'skills-discovery-'))
  try {
    const home = join(base, 'home')
    const cwd = join(base, 'proj')

    const piGlobal = join(home, '.pi', 'agent', 'skills')
    await writeSkill(piGlobal, 'alpha')
    await writeSkill(join(piGlobal, 'group'), 'nested')
    await mkdir(piGlobal, { recursive: true })
    await writeFile(join(piGlobal, 'note.md'), skillMd('note'), 'utf-8')

    const ompGlobal = join(home, '.omp', 'agent', 'skills')
    await writeSkill(ompGlobal, 'omp-global')
    await writeSkill(join(ompGlobal, 'group'), 'omp-nested')

    await writeSkill(join(home, '.claude', 'skills'), 'claude-global')
    await writeSkill(join(home, '.agents', 'skills'), 'shared')

    await writeSkill(join(cwd, '.pi', 'skills'), 'proj-pi')
    await writeSkill(join(cwd, '.omp', 'skills'), 'proj-omp')
    await writeSkill(join(cwd, '.omp', 'skills'), 'claude-global-dir', 'claude-global')
    await writeSkill(join(cwd, '.claude', 'skills'), 'proj-claude')

    return await fn(home, cwd)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

const names = (skills: InstalledSkill[]): string[] => skills.map((s) => s.name).sort()

test('listSkills for Pi sees only Pi and .agents roots, recursively', async () => {
  await withSkillTree(async (home, cwd) => {
    const skills = await listSkills(cwd, 'pi', home)
    assert.deepEqual(names(skills), ['alpha', 'nested', 'note', 'proj-pi', 'shared'])
  })
})

test('listSkills for OMP sees .omp, .claude and .agents roots, one level deep', async () => {
  await withSkillTree(async (home, cwd) => {
    const skills = await listSkills(cwd, 'omp', home)
    assert.deepEqual(names(skills), [
      'claude-global',
      'omp-global',
      'proj-claude',
      'proj-omp',
      'shared',
    ])
    // Nested groups are not discovered by OMP.
    assert.equal(skills.some((s) => s.name === 'omp-nested'), false)
    // The project copy wins the claude-global name collision.
    const collision = skills.find((s) => s.name === 'claude-global')
    assert.equal(collision?.source, 'project')
  })
})

test('listSkills returns [] when no roots exist', async () => {
  const base = await mkdtemp(join(tmpdir(), 'skills-discovery-empty-'))
  try {
    assert.deepEqual(await listSkills(join(base, 'proj'), 'pi', join(base, 'home')), [])
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

// ─── parseSkillFrontmatter ───────────────────────────────────────────────────

test('parseSkillFrontmatter extracts name and description', () => {
  assert.deepEqual(parseSkillFrontmatter(skillMd('demo')), {
    name: 'demo',
    description: 'demo does things',
  })
})

test('parseSkillFrontmatter rejects files without both fields', () => {
  assert.equal(parseSkillFrontmatter('no frontmatter'), null)
  assert.equal(parseSkillFrontmatter('---\nname: only-name\n---\n'), null)
})

// ─── mergeRpcSkills ──────────────────────────────────────────────────────────

const diskSkill: InstalledSkill = {
  name: 'on-disk',
  description: 'found by scan',
  path: '/tmp/on-disk/SKILL.md',
  source: 'global',
  enabled: true,
}

test('mergeRpcSkills adds catalog-only skills with an rpc pseudo-path', () => {
  const skills = [diskSkill]
  mergeRpcSkills(skills, [
    { name: 'skill:plugin-only', description: 'from a plugin', source: 'skill' },
    { name: 'pi-style-name', description: 'pi catalog entry', source: 'skill', path: '/pkg/SKILL.md' },
    { name: 'skill:on-disk', description: 'already scanned', source: 'skill' },
    { name: 'not-a-skill', description: 'extension command', source: 'extension' },
    'garbage',
    null,
  ])
  assert.deepEqual(skills.map((s) => ({ name: s.name, path: s.path, source: s.source })), [
    { name: 'on-disk', path: '/tmp/on-disk/SKILL.md', source: 'global' },
    { name: 'plugin-only', path: `${RPC_SKILL_PATH_PREFIX}plugin-only`, source: 'package' },
    { name: 'pi-style-name', path: '/pkg/SKILL.md', source: 'package' },
  ])
})

test('mergeRpcSkills leaves the list unchanged for an empty catalog', () => {
  const skills = [diskSkill]
  mergeRpcSkills(skills, [])
  assert.deepEqual(skills, [diskSkill])
})

test('parseSkillFrontmatter accepts CRLF endings and a UTF-8 BOM', () => {
  assert.deepEqual(parseSkillFrontmatter('---\r\nname: win\r\ndescription: crlf file\r\n---\r\n\r\nBody\r\n'), {
    name: 'win',
    description: 'crlf file',
  })
  assert.deepEqual(parseSkillFrontmatter('﻿---\nname: bom\ndescription: bom file\n---\n'), {
    name: 'bom',
    description: 'bom file',
  })
})
