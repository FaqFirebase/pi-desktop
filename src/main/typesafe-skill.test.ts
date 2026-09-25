import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'crypto'
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  TYPESAFE_SKILL_FILES,
  TYPESAFE_SKILL_VERSION,
  getTypeSafeSkillStatus,
  installTypeSafeSkill,
  removeTypeSafeSkill,
  typeSafeSkillDir,
  typeSafeSkillFileUrl,
  type SkillFile,
} from './typesafe-skill'

const HTTP_OK = 200
const HTTP_NOT_FOUND = 404
const INSTALL_MARKER = '.pi-desktop-install.json'

const SKILL_TEXT = '---\nname: typesafe-ai\n---\nUse TypeSafe.\n'
const LICENSE_TEXT = 'MIT License\n'

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

const TEST_FILES: readonly SkillFile[] = [
  { name: 'SKILL.md', sha256: sha256(SKILL_TEXT) },
  { name: 'LICENSE', sha256: sha256(LICENSE_TEXT) },
]

const BODIES: Record<string, string> = { 'SKILL.md': SKILL_TEXT, LICENSE: LICENSE_TEXT }

function fakeFetch(overrides: Record<string, { status: number; body: string }> = {}) {
  const requested: string[] = []
  const fetchImpl = async (url: string): Promise<Response> => {
    requested.push(url)
    const name = url.slice(url.lastIndexOf('/') + 1)
    const reply = overrides[name] ?? { status: HTTP_OK, body: BODIES[name] }
    return new Response(reply.body, { status: reply.status })
  }
  return { fetchImpl, requested }
}

async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'pi-typesafe-skill-'))
}

test('the skill installs into the .agents root both engines read', async () => {
  const homeDir = await tempHome()
  assert.equal(typeSafeSkillDir(homeDir), join(homeDir, '.agents', 'skills', 'typesafe-ai'))
})

test('download URLs point at the pinned release tag of the official repository', () => {
  assert.equal(
    typeSafeSkillFileUrl('SKILL.md'),
    `https://raw.githubusercontent.com/typesafe-ai/skills/${TYPESAFE_SKILL_VERSION}/skills/typesafe-ai/SKILL.md`,
  )
  assert.deepEqual(TYPESAFE_SKILL_FILES.map((file) => file.name), ['SKILL.md', 'LICENSE'])
})

test('nothing is installed in a fresh home', async () => {
  const status = await getTypeSafeSkillStatus(await tempHome())
  assert.equal(status.state, 'not-installed')
  assert.equal(status.installedVersion, null)
  assert.equal(status.pinnedVersion, TYPESAFE_SKILL_VERSION)
})

test('install writes the verified files and records that Pi Desktop owns them', async () => {
  const homeDir = await tempHome()
  const { fetchImpl, requested } = fakeFetch()
  const status = await installTypeSafeSkill({ homeDir, fetchImpl, files: TEST_FILES })

  const dir = typeSafeSkillDir(homeDir)
  assert.equal(await readFile(join(dir, 'SKILL.md'), 'utf8'), SKILL_TEXT)
  assert.equal(await readFile(join(dir, 'LICENSE'), 'utf8'), LICENSE_TEXT)
  assert.ok(existsSync(join(dir, INSTALL_MARKER)))
  assert.deepEqual(requested, [typeSafeSkillFileUrl('SKILL.md'), typeSafeSkillFileUrl('LICENSE')])
  assert.equal(status.state, 'installed')
  assert.equal(status.installedVersion, TYPESAFE_SKILL_VERSION)
})

test('a file whose checksum does not match is rejected and nothing is installed', async () => {
  const homeDir = await tempHome()
  const { fetchImpl } = fakeFetch({ 'SKILL.md': { status: HTTP_OK, body: 'tampered' } })
  await assert.rejects(installTypeSafeSkill({ homeDir, fetchImpl, files: TEST_FILES }))
  assert.equal((await getTypeSafeSkillStatus(homeDir)).state, 'not-installed')
  // Verification runs before any write, so not even the .agents folder appears.
  assert.deepEqual(await readdir(homeDir), [])
})

test('a failed download is reported and nothing is installed', async () => {
  const homeDir = await tempHome()
  const { fetchImpl } = fakeFetch({ LICENSE: { status: HTTP_NOT_FOUND, body: '' } })
  await assert.rejects(installTypeSafeSkill({ homeDir, fetchImpl, files: TEST_FILES }))
  assert.equal((await getTypeSafeSkillStatus(homeDir)).state, 'not-installed')
})

test('a copy installed by something else is reported and never touched', async () => {
  const homeDir = await tempHome()
  const dir = typeSafeSkillDir(homeDir)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), 'user copy')

  assert.equal((await getTypeSafeSkillStatus(homeDir)).state, 'installed-elsewhere')
  const { fetchImpl, requested } = fakeFetch()
  await assert.rejects(installTypeSafeSkill({ homeDir, fetchImpl, files: TEST_FILES }))
  await assert.rejects(removeTypeSafeSkill(homeDir))
  assert.deepEqual(requested, [])
  assert.equal(await readFile(join(dir, 'SKILL.md'), 'utf8'), 'user copy')
})

test('installing again replaces an older copy Pi Desktop installed', async () => {
  const homeDir = await tempHome()
  const dir = typeSafeSkillDir(homeDir)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), 'old skill')
  await writeFile(join(dir, INSTALL_MARKER), JSON.stringify({ installedBy: 'pi-desktop', version: 'v0.0.1' }))
  assert.equal((await getTypeSafeSkillStatus(homeDir)).installedVersion, 'v0.0.1')

  const { fetchImpl } = fakeFetch()
  const status = await installTypeSafeSkill({ homeDir, fetchImpl, files: TEST_FILES })
  assert.equal(status.installedVersion, TYPESAFE_SKILL_VERSION)
  assert.equal(await readFile(join(dir, 'SKILL.md'), 'utf8'), SKILL_TEXT)
})

test('remove deletes a copy Pi Desktop installed', async () => {
  const homeDir = await tempHome()
  const { fetchImpl } = fakeFetch()
  await installTypeSafeSkill({ homeDir, fetchImpl, files: TEST_FILES })

  const status = await removeTypeSafeSkill(homeDir)
  assert.equal(status.state, 'not-installed')
  assert.equal(existsSync(typeSafeSkillDir(homeDir)), false)
})

test('remove when nothing is installed succeeds', async () => {
  const status = await removeTypeSafeSkill(await tempHome())
  assert.equal(status.state, 'not-installed')
})
