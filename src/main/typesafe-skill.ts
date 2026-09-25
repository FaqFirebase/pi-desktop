import { createHash } from 'crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname, join } from 'path'
import type { TypeSafeSkillStatus } from '../shared/ipc-contracts'
import { t } from '../shared/i18n'
import { agentsSkillsDir } from './skills-discovery'

/**
 * Installs TypeSafe's official agent skill for Pi and OMP.
 *
 * The files are downloaded from a pinned release tag and checked against
 * pinned SHA-256 digests, so a moved tag or a tampered file is refused rather
 * than handed to the agent as instructions. A newer skill release means
 * updating the tag and digests below.
 */

const TYPESAFE_SKILL_NAME = 'typesafe-ai'
export const TYPESAFE_SKILL_VERSION = 'v0.5.7'

const SKILL_REPOSITORY_RAW_BASE = 'https://raw.githubusercontent.com/typesafe-ai/skills'

export interface SkillFile {
  name: string
  sha256: string
}

export const TYPESAFE_SKILL_FILES: readonly SkillFile[] = [
  { name: 'SKILL.md', sha256: '71ea90d7906c6554c4f4c460ef7361b2d26f59116ccdae986dc6d997b9389f52' },
  { name: 'LICENSE', sha256: '835f233f1d6ed84a9b9a351aba0689b47644a4137d6316911fc7957bde523b02' },
]

// Written into the skill folder so Pi Desktop only ever replaces or removes a
// copy it put there itself. Neither engine loads .json files as skills.
const INSTALL_MARKER_FILE = '.pi-desktop-install.json'
const INSTALLED_BY = 'pi-desktop'

type FetchLike = (url: string) => Promise<Response>

export interface InstallTypeSafeSkillDeps {
  homeDir: string
  fetchImpl?: FetchLike
  files?: readonly SkillFile[]
}

interface InstallMarker {
  installedBy: string
  version: string
}

export function typeSafeSkillDir(homeDir: string): string {
  return join(agentsSkillsDir(homeDir), TYPESAFE_SKILL_NAME)
}

export function typeSafeSkillFileUrl(fileName: string): string {
  return `${SKILL_REPOSITORY_RAW_BASE}/${TYPESAFE_SKILL_VERSION}/skills/${TYPESAFE_SKILL_NAME}/${fileName}`
}

// Staged beside the skills root, not inside it: a crash mid-install must not
// leave a second SKILL.md where Pi's recursive scan would load it.
function stagingDir(homeDir: string): string {
  return join(dirname(agentsSkillsDir(homeDir)), `.pi-desktop-staging-${TYPESAFE_SKILL_NAME}`)
}

async function readInstallMarker(dir: string): Promise<InstallMarker | null> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, INSTALL_MARKER_FILE), 'utf8')) as Partial<InstallMarker>
    if (parsed.installedBy !== INSTALLED_BY || typeof parsed.version !== 'string') return null
    return { installedBy: parsed.installedBy, version: parsed.version }
  } catch {
    return null
  }
}

export async function getTypeSafeSkillStatus(homeDir: string): Promise<TypeSafeSkillStatus> {
  const directory = typeSafeSkillDir(homeDir)
  const base = { pinnedVersion: TYPESAFE_SKILL_VERSION, directory }
  if (!existsSync(directory)) return { ...base, state: 'not-installed', installedVersion: null }

  const marker = await readInstallMarker(directory)
  if (!marker) return { ...base, state: 'installed-elsewhere', installedVersion: null }
  return { ...base, state: 'installed', installedVersion: marker.version }
}

async function downloadVerified(file: SkillFile, fetchImpl: FetchLike): Promise<Buffer> {
  const response = await fetchImpl(typeSafeSkillFileUrl(file.name))
  if (!response.ok) {
    throw new Error(t('errors.typesafe.skillDownloadFailed', { file: file.name, status: response.status }))
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== file.sha256) {
    throw new Error(t('errors.typesafe.skillChecksumMismatch', { file: file.name }))
  }
  return bytes
}

function refuseForeignCopy(status: TypeSafeSkillStatus): void {
  if (status.state === 'installed-elsewhere') {
    throw new Error(t('errors.typesafe.skillInstalledElsewhere', { directory: status.directory }))
  }
}

/** Download, verify and install the skill, replacing an older Pi Desktop copy. */
export async function installTypeSafeSkill(deps: InstallTypeSafeSkillDeps): Promise<TypeSafeSkillStatus> {
  const { homeDir, fetchImpl = fetch, files = TYPESAFE_SKILL_FILES } = deps
  const current = await getTypeSafeSkillStatus(homeDir)
  refuseForeignCopy(current)

  // Every file is fetched and verified before anything touches the disk.
  const contents = await Promise.all(files.map((file) => downloadVerified(file, fetchImpl)))

  const staging = stagingDir(homeDir)
  const target = typeSafeSkillDir(homeDir)
  const marker: InstallMarker = { installedBy: INSTALLED_BY, version: TYPESAFE_SKILL_VERSION }
  try {
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true })
    await Promise.all(files.map((file, index) => writeFile(join(staging, file.name), contents[index])))
    await writeFile(join(staging, INSTALL_MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`)

    await mkdir(dirname(target), { recursive: true })
    if (current.state === 'installed') await rm(target, { recursive: true, force: true })
    await rename(staging, target)
  } catch (err) {
    await rm(staging, { recursive: true, force: true })
    throw err
  }
  return getTypeSafeSkillStatus(homeDir)
}

/** Remove the skill, but only a copy Pi Desktop installed. */
export async function removeTypeSafeSkill(homeDir: string): Promise<TypeSafeSkillStatus> {
  const current = await getTypeSafeSkillStatus(homeDir)
  refuseForeignCopy(current)
  if (current.state === 'installed') {
    await rm(typeSafeSkillDir(homeDir), { recursive: true, force: true })
  }
  return getTypeSafeSkillStatus(homeDir)
}
