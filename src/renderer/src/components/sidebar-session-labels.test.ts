import assert from 'node:assert/strict'
import { getSessionRowLabels } from './sidebar-session-labels'

const namelessCurrentWorkspace = {
  name: null,
  preview: null,
  sessionId: '2026-06-20T215802',
  projectName: 'pi gui',
  projectPath: '/work/pi-gui',
}

assert.deepEqual(getSessionRowLabels(namelessCurrentWorkspace), {
  title: '2026-06-20T2',
  subtitle: 'pi gui',
})

assert.deepEqual(
  getSessionRowLabels({
    ...namelessCurrentWorkspace,
    name: 'Rename context menu',
  }),
  {
    title: 'Rename context menu',
    subtitle: 'pi gui',
  }
)

// An unnamed session falls back to its first-message preview rather than to the
// session id, which is what made same-day sessions indistinguishable.
assert.deepEqual(
  getSessionRowLabels({
    ...namelessCurrentWorkspace,
    preview: 'Refactor auth module login logic',
  }),
  {
    title: 'Refactor auth module login logic',
    subtitle: 'pi gui',
  }
)

// An explicit name still outranks the preview.
assert.deepEqual(
  getSessionRowLabels({
    ...namelessCurrentWorkspace,
    name: 'debug token refresh',
    preview: 'Refactor auth module login logic',
  }),
  {
    title: 'debug token refresh',
    subtitle: 'pi gui',
  }
)
