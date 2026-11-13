import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ALLOW_MULTIPLE_INSTANCES_ENV_VAR,
  multipleInstancesRequestedByEnv,
  persistAllowMultipleInstancesSync,
  readAllowMultipleInstancesSync,
  resolveMultipleInstances,
} from './instance-mode'

async function withSettingsFile(run: (settingsPath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-instance-mode-'))
  try {
    await run(join(dir, 'settings.json'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('only an explicit opt-in value of the environment variable allows multiple instances', () => {
  for (const value of ['1', 'true', 'TRUE', ' yes ', 'on']) {
    assert.equal(multipleInstancesRequestedByEnv({ [ALLOW_MULTIPLE_INSTANCES_ENV_VAR]: value }), true, value)
  }
  for (const value of ['', '0', 'false', 'no', 'maybe']) {
    assert.equal(multipleInstancesRequestedByEnv({ [ALLOW_MULTIPLE_INSTANCES_ENV_VAR]: value }), false, value)
  }
  assert.equal(multipleInstancesRequestedByEnv({}), false)
})

test('a single instance is the default, whatever state the settings file is in', async () => {
  await withSettingsFile(async (settingsPath) => {
    assert.equal(readAllowMultipleInstancesSync(settingsPath), false, 'missing file')
    await writeFile(settingsPath, '{ not json')
    assert.equal(readAllowMultipleInstancesSync(settingsPath), false, 'broken file')
    await writeFile(settingsPath, JSON.stringify({ allowMultipleInstances: 'yes' }))
    assert.equal(readAllowMultipleInstancesSync(settingsPath), false, 'not a boolean')
    await writeFile(settingsPath, JSON.stringify({ allowMultipleInstances: true }))
    assert.equal(readAllowMultipleInstancesSync(settingsPath), true, 'turned on')
  })
})

test('the folder setting allows multiple instances without the environment flag', async () => {
  await withSettingsFile(async (settingsPath) => {
    await writeFile(settingsPath, JSON.stringify({ allowMultipleInstances: true }))
    assert.equal(resolveMultipleInstances({}, settingsPath), true)
  })
})

test('the environment flag saves the option into the folder, keeping its other settings', async () => {
  await withSettingsFile(async (settingsPath) => {
    await writeFile(settingsPath, JSON.stringify({ theme: 'dark', allowMultipleInstances: false }))
    assert.equal(resolveMultipleInstances({ [ALLOW_MULTIPLE_INSTANCES_ENV_VAR]: '1' }, settingsPath), true)
    assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf-8')), { theme: 'dark', allowMultipleInstances: true })
    // A later launch of the same folder without the flag takes the same lock.
    assert.equal(resolveMultipleInstances({}, settingsPath), true)
  })
})

test('saving the option creates a missing settings file but never replaces a broken one', async () => {
  await withSettingsFile(async (settingsPath) => {
    persistAllowMultipleInstancesSync(settingsPath)
    assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf-8')), { allowMultipleInstances: true })

    await writeFile(settingsPath, '{ not json')
    persistAllowMultipleInstancesSync(settingsPath)
    assert.equal(await readFile(settingsPath, 'utf-8'), '{ not json')

    await writeFile(settingsPath, '[1, 2]')
    persistAllowMultipleInstancesSync(settingsPath)
    assert.equal(await readFile(settingsPath, 'utf-8'), '[1, 2]')
  })
})
