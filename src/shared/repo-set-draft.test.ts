import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RepoSetMember } from './ipc-contracts'
import {
  addRepoSetMember,
  removeRepoSetMember,
  renameRepoSetMember,
  repoSetDraftProblem,
  setMainRepoSetMember,
  uniqueRepoName,
} from './repo-set-draft'

const APP: RepoSetMember = { name: 'app', sourcePath: '/src/app', role: 'main' }
const LIB: RepoSetMember = { name: 'lib', sourcePath: '/src/lib', role: 'linked' }

test('uniqueRepoName adds the first free number, ignoring case', () => {
  assert.equal(uniqueRepoName('app', ['lib']), 'app')
  assert.equal(uniqueRepoName('app', ['App']), 'app-2')
  assert.equal(uniqueRepoName('app', ['app', 'app-2']), 'app-3')
})

test('the first added repository is the main one; later ones are linked and get unique names', () => {
  const one = addRepoSetMember([], { path: '/src/app', name: 'app' })
  assert.deepEqual(one, [APP])
  const two = addRepoSetMember(one, { path: '/other/app', name: 'app' })
  assert.deepEqual(two[1], { name: 'app-2', sourcePath: '/other/app', role: 'linked' })
})

test('removing the main repository makes the first one left the main one', () => {
  assert.deepEqual(removeRepoSetMember([APP, LIB], 0), [{ ...LIB, role: 'main' }])
  assert.deepEqual(removeRepoSetMember([APP, LIB], 1), [APP])
  assert.deepEqual(removeRepoSetMember([APP], 0), [])
})

test('setMainRepoSetMember keeps exactly one main repository', () => {
  assert.deepEqual(setMainRepoSetMember([APP, LIB], 1).map((member) => member.role), ['linked', 'main'])
})

test('renameRepoSetMember changes only the named row', () => {
  assert.deepEqual(renameRepoSetMember([APP, LIB], 1, 'core'), [APP, { ...LIB, name: 'core' }])
})

test('repoSetDraftProblem reports the first broken rule, or null', () => {
  assert.equal(repoSetDraftProblem('Shop', [APP, LIB]), null)
  assert.deepEqual(repoSetDraftProblem('  ', [APP, LIB]), { code: 'nameRequired' })
  assert.deepEqual(repoSetDraftProblem('Shop', [APP]), { code: 'tooFewRepositories' })
  assert.deepEqual(repoSetDraftProblem('Shop', [APP, { ...LIB, name: ' ' }]), { code: 'repositoryNameRequired' })
  assert.deepEqual(repoSetDraftProblem('Shop', [APP, { ...LIB, name: 'APP' }]), { code: 'duplicateName', name: 'APP' })
  assert.deepEqual(repoSetDraftProblem('Shop', [APP, { ...LIB, role: 'main' }]), { code: 'oneMainRepository' })
  assert.deepEqual(repoSetDraftProblem('Shop', [{ ...APP, role: 'linked' }, LIB]), { code: 'oneMainRepository' })
})
