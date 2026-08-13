import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { mapWithConcurrency } from './map-concurrent'

export interface InstalledSkill {
  name: string
  description: string
  path: string
  source: string
  enabled: boolean
}

// listSkills is called from several paths at startup (the Packages & Skills
// view on mount, the command palette, and every `status_change → running`
// event). Each call scans every skills root recursively and readFile()s each
// SKILL.md, so a burst of overlapping calls (window mount racing the Pi
// process becoming ready) used to fan out thousands of file reads at once and
// peg the main process. Cache the result per (cwd, home) and coalesce
// in-flight scans so concurrent callers share one pass.
const SKILLS_CACHE_TTL_MS = 10_000
const skillListCache = new Map<string, { expiresAt: number; skills: InstalledSkill[] }>()
const skillListInFlight = new Map<string, Promise<InstalledSkill[]>>()

function skillsCacheKey(cwd: string, homeDir: string): string {
  return `${cwd}\u0000${homeDir}`
}

export async function listSkills(cwd: string, homeDir: string): Promise<InstalledSkill[]> {
  const key = skillsCacheKey(cwd, homeDir)

  const cached = skillListCache.get(key)
  if (cached && cached.expiresAt > Date.now()) {
    // Keep the cache fresh on hit so a busy consumer can't starve it out.
    cached.expiresAt = Date.now() + SKILLS_CACHE_TTL_MS
    return cached.skills
  }

  const inFlight = skillListInFlight.get(key)
  if (inFlight) return inFlight

  const scan = (async () => {
    const skills: InstalledSkill[] = []

    // Global skills
    const globalPaths = [
      join(homeDir, '.pi', 'agent', 'skills'),
      join(homeDir, '.agents', 'skills'),
    ]

    for (const skillsDir of globalPaths) {
      await collectSkills(skillsDir, skills, 'global')
    }

    // Project skills
    const projectPaths = [
      join(cwd, '.pi', 'skills'),
      join(cwd, '.agents', 'skills'),
    ]

    for (const skillsDir of projectPaths) {
      await collectSkills(skillsDir, skills, 'project')
    }

    return skills
  })()

  skillListInFlight.set(key, scan)
  try {
    const skills = await scan
    skillListCache.set(key, { expiresAt: Date.now() + SKILLS_CACHE_TTL_MS, skills })
    return skills
  } finally {
    skillListInFlight.delete(key)
  }
}

export async function collectSkills(
  dir: string,
  skills: InstalledSkill[],
  source: string
): Promise<void> {
  try {
    if (!existsSync(dir)) return

    const items = await readdir(dir, { withFileTypes: true })

    // Gather every candidate (root .md files and SKILL.md files) first, then
    // read them with bounded concurrency. The previous loop awaited each
    // readFile serially; with many roots that is slow, and with many callers
    // racing it multiplied into a file-descriptor burst.
    const files: Array<{ path: string; name: string }> = []
    const subdirs: string[] = []

    for (const item of items) {
      const fullPath = join(dir, item.name)
      if (item.isFile() && item.name.endsWith('.md') && item.name !== 'SKILL.md') {
        files.push({ path: fullPath, name: item.name })
      } else if (item.isDirectory()) {
        const skillFile = join(fullPath, 'SKILL.md')
        if (existsSync(skillFile)) files.push({ path: skillFile, name: 'SKILL.md' })
        subdirs.push(fullPath)
      }
    }

    await mapWithConcurrency(files, 8, async (file) => {
      try {
        const content = await readFile(file.path, 'utf-8')
        const parsed = parseSkillFrontmatter(content)
        if (parsed) {
          skills.push({
            name: parsed.name,
            description: parsed.description,
            path: file.path,
            source,
            enabled: true,
          })
        }
      } catch {
        // Skip unreadable files
      }
    })

    // Recurse into subdirectories, one level at a time, so file reads stay
    // bounded by the concurrency limit above.
    for (const subdir of subdirs) {
      await collectSkills(subdir, skills, source)
    }
  } catch {
    // Directory doesn't exist or isn't readable
  }
}

export function parseSkillFrontmatter(content: string): { name: string; description: string } | null {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/)
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
