import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  currentOmpProfile,
  ompAgentDirIn,
  ompPluginsDirIn,
  ompProfileArg,
  ompProfileArgEnv,
  ompProfileRootIn,
  ompProfileSelection,
  setOmpLaunchArgs,
} from './omp-paths'

/**
 * OMP reads its profile from its arguments, else from the environment. The
 * app's agent processes inherit that environment and get the "default args"
 * setting, so the files the app shows (sessions, models, MCP servers, skills,
 * plugins) must come from the same profile.
 */

test('OMP_PROFILE selects the profile, by OMP precedence', () => {
  assert.deepEqual(ompProfileSelection([], { OMP_PROFILE: 'work' }), { profile: 'work' })
  assert.deepEqual(ompProfileSelection([], { OMP_PROFILE: ' work ' }), { profile: 'work' })
  // The legacy PI_PROFILE counts only while OMP_PROFILE is undefined...
  assert.deepEqual(ompProfileSelection([], { PI_PROFILE: 'legacy' }), { profile: 'legacy' })
  assert.deepEqual(ompProfileSelection([], { OMP_PROFILE: 'work', PI_PROFILE: 'legacy' }), { profile: 'work' })
  // ...so an explicitly empty OMP_PROFILE still means the default profile.
  assert.deepEqual(ompProfileSelection([], { OMP_PROFILE: '', PI_PROFILE: 'legacy' }), { profile: undefined })
})

test('no profile, empty, or "default" is the default profile', () => {
  for (const env of [{}, { OMP_PROFILE: '' }, { OMP_PROFILE: '  ' }, { OMP_PROFILE: 'default' }]) {
    assert.deepEqual(ompProfileSelection([], env), { profile: undefined })
    assert.equal(currentOmpProfile(env), undefined)
  }
})

test('a name OMP would refuse reads the default profile and is reported', () => {
  assert.deepEqual(ompProfileSelection([], { OMP_PROFILE: '../escape' }), { profile: undefined, invalid: '../escape' })
  assert.deepEqual(ompProfileSelection([], { OMP_PROFILE: 'Work' }), { profile: undefined, invalid: 'Work' })
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

test('--profile in the arguments is read the way OMP reads its argv', () => {
  assert.equal(ompProfileArg([]), undefined)
  assert.equal(ompProfileArg(['--model', 'gpt']), undefined)
  assert.equal(ompProfileArg(['--profile', 'work']), 'work')
  assert.equal(ompProfileArg(['--profile=work']), 'work')
  // The last one wins.
  assert.equal(ompProfileArg(['--profile', 'work', '--profile=home']), 'home')
  // Nothing after `--` is an option.
  assert.equal(ompProfileArg(['--profile', 'work', '--', '--profile', 'home']), 'work')
  // OMP refuses a flag with no name, or with a dash-led one.
  assert.equal(ompProfileArg(['--profile']), '')
  assert.equal(ompProfileArg(['--profile=']), '')
  assert.equal(ompProfileArg(['--profile', '--model', 'gpt']), '')
})

test('--profile in the arguments wins over the environment', () => {
  assert.deepEqual(ompProfileSelection(['--profile', 'work'], { OMP_PROFILE: 'home' }), { profile: 'work' })
  // `--profile default` selects the default profile, whatever the environment says.
  assert.deepEqual(ompProfileSelection(['--profile=default'], { OMP_PROFILE: 'home' }), { profile: undefined })
  assert.deepEqual(ompProfileSelection(['--profile', 'Work'], {}), { profile: undefined, invalid: 'Work' })
  assert.deepEqual(ompProfileSelection(['--profile'], { OMP_PROFILE: 'home' }), { profile: undefined, invalid: '' })
})

test('the saved default args select the profile the app reads and its children run under', () => {
  try {
    assert.deepEqual(setOmpLaunchArgs(['--profile', 'work']), { profile: 'work' })
    assert.equal(currentOmpProfile({ OMP_PROFILE: 'home' }), 'work')
    assert.deepEqual(ompProfileArgEnv(), { OMP_PROFILE: 'work' })
    setOmpLaunchArgs([])
    assert.equal(currentOmpProfile({ OMP_PROFILE: 'home' }), 'home')
    // No profile argument leaves the children's environment as it is.
    assert.deepEqual(ompProfileArgEnv(), {})
  } finally {
    setOmpLaunchArgs([])
  }
})

test('OMP_PROFILE in ~/.pi/.env selects the profile, as it does for every OMP child', () => {
  const home = mkdtempSync(join(tmpdir(), 'omp-profile-dotenv-'))
  const saved = { HOME: process.env.HOME, OMP_PROFILE: process.env.OMP_PROFILE, PI_PROFILE: process.env.PI_PROFILE }
  try {
    mkdirSync(join(home, '.pi'))
    writeFileSync(join(home, '.pi', '.env'), 'OMP_PROFILE=from-file\n')
    process.env.HOME = home
    delete process.env.OMP_PROFILE
    delete process.env.PI_PROFILE
    assert.equal(currentOmpProfile(), 'from-file')
    // A real environment variable still wins over the file.
    process.env.OMP_PROFILE = 'from-env'
    assert.equal(currentOmpProfile(), 'from-env')
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(home, { recursive: true, force: true })
  }
})
