import assert from 'node:assert/strict'
import { test } from 'node:test'
import { launchView } from './launch-view'

test('a launch follows the open-to-Home setting', () => {
  assert.equal(launchView({ openToHomeOnLaunch: true, navigationType: 'navigate' }), 'home')
  assert.equal(launchView({ openToHomeOnLaunch: false, navigationType: 'navigate' }), 'chat')
  assert.equal(launchView({ openToHomeOnLaunch: true, navigationType: null }), 'home')
})

test('a reload returns to Chat, where the restored session shows', () => {
  assert.equal(launchView({ openToHomeOnLaunch: true, navigationType: 'reload' }), 'chat')
})
