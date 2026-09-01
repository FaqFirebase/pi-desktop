import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'
import { RPC_SKILL_PATH_PREFIX, type InstalledSkill } from '../shared/ipc-contracts'

/**
 * Per-engine skill discovery for the Skills panel.
 *
 * Each engine only lists skills it actually loads, so a skill visible under
 * OMP (e.g. from `~/.claude/skills`) is not offered while Pi runs, and
 * Pi-only skills stay hidden under OMP:
 *
 *  - Pi reads `~/.pi/agent/skills`, `~/.agents/skills` and the project's
 *    `.pi/skills` / `.agents/skills`, recursively, including bare root
 *    `<name>.md` files.
 *  - OMP reads its native `.omp` roots plus Claude Code and `.agents` roots,
 *    one directory level deep (`<root>/<skill>/SKILL.md` only — OMP does not
 *    discover nested skill groups or bare root markdown files).
 */

interface SkillScanPlan {
  dirs: { dir: string; source: 'global' | 'project' }[]
  recursive: boolean
  rootMdFiles: boolean
}

function skillScanPlan(cwd: string, homeDir: string, engine: 'pi' | 'omp'): SkillScanPlan {
  if (engine === 'omp') {
    return {
      dirs: [
        { dir: join(cwd, '.omp', 'skills'), source: 'project' },
        { dir: join(homeDir, '.omp', 'agent', 'skills'), source: 'global' },
        { dir: join(cwd, '.claude', 'skills'), source: 'project' },
        { dir: join(homeDir, '.claude', 'skills'), source: 'global' },
        { dir: join(cwd, '.agents', 'skills'), source: 'project' },
        { dir: join(homeDir, '.agents', 'skills'), source: 'global' },
      ],
      recursive: false,
      rootMdFiles: false,
    }
  }
  return {
    dirs: [
      { dir: join(cwd, '.pi', 'skills'), source: 'project' },
      { dir: join(homeDir, '.pi', 'agent', 'skills'), source: 'global' },
      { dir: join(cwd, '.agents', 'skills'), source: 'project' },
      { dir: join(homeDir, '.agents', 'skills'), source: 'global' },
    ],
    recursive: true,
    rootMdFiles: true,
  }
}

export async function listSkills(
  cwd: string,
  engine: 'pi' | 'omp',
  homeDir: string = process.env.HOME ?? process.env.USERPROFILE ?? ''
): Promise<InstalledSkill[]> {
  const { dirs, recursive, rootMdFiles } = skillScanPlan(cwd, homeDir, engine)

  const skills: InstalledSkill[] = []
  for (const { dir, source } of dirs) {
    await collectSkills(dir, skills, source, { recursive, rootMdFiles })
  }

  // Both engines resolve name collisions across roots first-wins, in the same
  // precedence order the scan above uses.
  const seen = new Set<string>()
  return skills.filter((skill) => {
    if (seen.has(skill.name)) return false
    seen.add(skill.name)
    return true
  })
}

interface CollectOptions {
  recursive: boolean
  rootMdFiles: boolean
}

async function collectSkills(
  dir: string,
  skills: InstalledSkill[],
  source: 'global' | 'project',
  options: CollectOptions
): Promise<void> {
  try {
    if (!existsSync(dir)) return

    const items = await readdir(dir, { withFileTypes: true })

    for (const item of items) {
      const fullPath = join(dir, item.name)

      if (item.isFile() && item.name.endsWith('.md') && item.name !== 'SKILL.md') {
        if (!options.rootMdFiles) continue
        // Root .md file as individual skill
        await pushSkillFile(fullPath, skills, source)
      } else if (item.isDirectory()) {
        // Directory with SKILL.md
        const skillFile = join(fullPath, 'SKILL.md')
        if (existsSync(skillFile)) {
          await pushSkillFile(skillFile, skills, source)
        }

        if (options.recursive) {
          await collectSkills(fullPath, skills, source, options)
        }
      }
    }
  } catch {
    // Directory doesn't exist or isn't readable
  }
}

async function pushSkillFile(
  filePath: string,
  skills: InstalledSkill[],
  source: 'global' | 'project'
): Promise<void> {
  try {
    const content = await readFile(filePath, 'utf-8')
    const parsed = parseSkillFrontmatter(content)
    if (parsed) {
      skills.push({
        name: parsed.name,
        description: parsed.description,
        path: filePath,
        source,
        enabled: true,
      })
    }
  } catch {
    // Skip unreadable files
  }
}

export function parseSkillFrontmatter(content: string): { name: string; description: string } | null {
  // Windows-authored files carry CRLF endings and sometimes a UTF-8 BOM; both
  // engines still load them, so the panel must too.
  const frontmatterMatch = content.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/)
  if (!frontmatterMatch) return null

  const frontmatter = frontmatterMatch[1]
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m)
  const descMatch = frontmatter.match(/^description:\s*(.+)$/m)

  if (!nameMatch || !descMatch) return null

  return {
    name: nameMatch[1].trim(),
    description: descMatch[1].trim(),
  }
}

/**
 * Merge catalog skills the disk scan missed (plugin and marketplace skills).
 * Entries carrying a real SKILL.md path stay readable; the rest get an
 * `rpc:`-prefixed pseudo-path the panel renders from the description.
 */
export function mergeRpcSkills(skills: InstalledSkill[], commands: unknown[]): void {
  const seen = new Set(skills.map((skill) => skill.name))
  for (const entry of commands) {
    if (typeof entry !== 'object' || entry === null) continue
    const cmd = entry as { name?: unknown; description?: unknown; source?: unknown; path?: unknown }
    if (cmd.source !== 'skill' || typeof cmd.name !== 'string') continue
    // Both engines list skills under their invocation token ("skill:foo").
    const name = cmd.name.startsWith('skill:') ? cmd.name.slice('skill:'.length) : cmd.name
    if (!name || seen.has(name)) continue
    seen.add(name)
    skills.push({
      name,
      description: typeof cmd.description === 'string' ? cmd.description : '',
      path: typeof cmd.path === 'string' && cmd.path.length > 0 ? cmd.path : `${RPC_SKILL_PATH_PREFIX}${name}`,
      source: 'package',
      enabled: true,
    })
  }
}
