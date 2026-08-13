import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectSkills, listSkills, parseSkillFrontmatter, type InstalledSkill } from './skills-lister'

function makeSkillDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'skills-lister-'))
}

const SKILL_MD = '---\nname: test-skill\ndescription: A test skill\n---\n# Body\n'

async function writeSkill(root: string, rel: string, content: string): Promise<string> {
  const full = join(root, rel)
  await mkdir(join(full, '..'), { recursive: true })
  await writeFile(full, content, 'utf-8')
  return full
}

test('parseSkillFrontmatter extracts name and description', () => {
  const parsed = parseSkillFrontmatter(SKILL_MD)
  assert.deepEqual(parsed, { name: 'test-skill', description: 'A test skill' })
})

test('parseSkillFrontmatter returns null for files without frontmatter', () => {
  assert.equal(parseSkillFrontmatter('# no frontmatter'), null)
})

test('collectSkills finds SKILL.md in nested directories and root .md files', async () => {
  const root = await makeSkillDir()
  try {
    await writeSkill(root, 'alpha/SKILL.md', SKILL_MD)
    await writeSkill(root, 'nested/beta/SKILL.md', '---\nname: beta\ndescription: B\n---\n')
    // Root .md file (non-SKILL.md) counts as a skill; SKILL.md at root does not.
    await writeSkill(root, 'root-skill.md', '---\nname: rooty\ndescription: R\n---\n')
    await writeSkill(root, 'SKILL.md', SKILL_MD)
    // Non-skill files are ignored.
    await writeSkill(root, 'notes.txt', 'not a skill')

    const skills: InstalledSkill[] = []
    await collectSkills(root, skills, 'test')
    const names = skills.map((s) => s.name).sort()
    assert.deepEqual(names, ['beta', 'rooty', 'test-skill'])
    assert.ok(skills.every((s) => s.source === 'test' && s.enabled))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('collectSkills ignores unreadable files without throwing', async () => {
  const root = await makeSkillDir()
  try {
    await writeSkill(root, 'ok/SKILL.md', SKILL_MD)
    const skills: InstalledSkill[] = []
    // Should not throw even with a nonexistent dir or broken file.
    await collectSkills(join(root, 'missing'), skills, 'test')
    await collectSkills(root, skills, 'test')
    assert.equal(skills.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('listSkills scans global and project roots and caches per cwd', async () => {
  const home = await makeSkillDir()
  const cwd = await makeSkillDir()
  try {
    await writeSkill(join(home, '.agents', 'skills'), 'global-skill/SKILL.md', '---\nname: global-skill\ndescription: G\n---\n')
    await writeSkill(join(cwd, '.pi', 'skills'), 'proj-skill/SKILL.md', '---\nname: proj\ndescription: P\n---\n')

    const skills = await listSkills(cwd, home)
    const names = skills.map((s) => s.name).sort()
    assert.deepEqual(names, ['global-skill', 'proj'])
    assert.ok(skills.some((s) => s.source === 'global'))
    assert.ok(skills.some((s) => s.source === 'project'))

    // Second call hits the cache: same array identity proves no re-scan.
    const again = await listSkills(cwd, home)
    assert.equal(again, skills)

    // A different cwd is a separate cache entry and still scans.
    const cwd2 = await mkdtemp(join(tmpdir(), 'skills-lister-cwd2-'))
    try {
      const other = await listSkills(cwd2, home)
      assert.deepEqual(other.map((s) => s.name), ['global-skill'])
    } finally {
      await rm(cwd2, { recursive: true, force: true })
    }
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(cwd, { recursive: true, force: true })
  }
})

test('listSkills coalesces concurrent calls into a single scan', async () => {
  const home = await makeSkillDir()
  const cwd = await makeSkillDir()
  try {
    await writeSkill(join(home, '.agents', 'skills'), 'a/SKILL.md', SKILL_MD)

    const [r1, r2, r3] = await Promise.all([listSkills(cwd, home), listSkills(cwd, home), listSkills(cwd, home)])
    // Same result array identity: the three callers shared one in-flight scan.
    assert.equal(r1, r2)
    assert.equal(r2, r3)
    assert.equal(r1.length, 1)
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(cwd, { recursive: true, force: true })
  }
})
