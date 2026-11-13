import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'path'
import { currentOmpProfile, ompAgentDirIn, ompPluginsDirIn, ompProfileFromEnv, ompProfileRootIn } from './omp-paths'

/**
 * OMP reads its profile from the environment. The app's agent processes
 * inherit that environment, so the files the app shows (sessions, models,
 * MCP servers, skills, plugins) must come from the same profile.
 */

test('OMP_PROFILE selects the profile, by OMP precedence', () => {
  assert.deepEqual(ompProfileFromEnv({ OMP_PROFILE: 'work' }), { profile: 'work' })
  assert.deepEqual(ompProfileFromEnv({ OMP_PROFILE: ' work ' }), { profile: 'work' })
  // The legacy PI_PROFILE counts only while OMP_PROFILE is undefined...
  assert.deepEqual(ompProfileFromEnv({ PI_PROFILE: 'legacy' }), { profile: 'legacy' })
  assert.deepEqual(ompProfileFromEnv({ OMP_PROFILE: 'work', PI_PROFILE: 'legacy' }), { profile: 'work' })
  // ...so an explicitly empty OMP_PROFILE still means the default profile.
  assert.deepEqual(ompProfileFromEnv({ OMP_PROFILE: '', PI_PROFILE: 'legacy' }), { profile: undefined })
})

test('no profile, empty, or "default" is the default profile', () => {
  for (const env of [{}, { OMP_PROFILE: '' }, { OMP_PROFILE: '  ' }, { OMP_PROFILE: 'default' }]) {
    assert.deepEqual(ompProfileFromEnv(env), { profile: undefined })
    assert.equal(currentOmpProfile(env), undefined)
  }
})

test('a name OMP would refuse reads the default profile and is reported', () => {
  assert.deepEqual(ompProfileFromEnv({ OMP_PROFILE: '../escape' }), { profile: undefined, invalid: '../escape' })
  assert.deepEqual(ompProfileFromEnv({ OMP_PROFILE: 'Work' }), { profile: undefined, invalid: 'Work' })
})

test('a named profile relocates the whole tree under ~/.omp/profiles', () => {
  const home = join('/home', 'tester')
  assert.equal(ompProfileRootIn(home, undefined), join(home, '.omp'))
  assert.equal(ompProfileRootIn(home, 'work'), join(home, '.omp', 'profiles', 'work'))
  assert.equal(ompAgentDirIn(home, undefined), join(home, '.omp', 'agent'))
  assert.equal(ompAgentDirIn(home, 'work'), join(home, '.omp', 'profiles', 'work', 'agent'))
  assert.equal(ompPluginsDirIn(home, undefined), join(home, '.omp', 'plugins'))
  assert.equal(ompPluginsDirIn(home, 'work'), join(home, '.omp', 'profiles', 'work', 'plugins'))
})
