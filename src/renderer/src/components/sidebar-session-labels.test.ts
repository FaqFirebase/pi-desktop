import assert from 'node:assert/strict'
import { getSessionEngineLabel, getSessionRowLabels, hasMixedSessionEngines } from './sidebar-session-labels'

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

// The tag names the CLI that owns the session, matching the status bar wording.
assert.equal(getSessionEngineLabel({ engine: 'pi' }), 'Pi')
assert.equal(getSessionEngineLabel({ engine: 'omp' }), 'OMP')

// A row from an older index carries no engine. It must stay untagged rather
// than be guessed at, because guessing would open a session with the wrong CLI.
assert.equal(getSessionEngineLabel({}), null)

// With one engine installed the tag would only repeat what every row already is.
assert.equal(hasMixedSessionEngines([]), false)
assert.equal(hasMixedSessionEngines([{ engine: 'pi' }, { engine: 'pi' }]), false)
assert.equal(hasMixedSessionEngines([{ engine: 'omp' }, { engine: 'omp' }]), false)

// An untagged row is not a second engine, so it alone must not turn tags on.
assert.equal(hasMixedSessionEngines([{ engine: 'omp' }, {}]), false)
assert.equal(hasMixedSessionEngines([{}, {}]), false)

// Two real engines on screen: the tag is now the only way to tell rows apart.
assert.equal(hasMixedSessionEngines([{ engine: 'pi' }, {}, { engine: 'omp' }]), true)
assert.equal(hasMixedSessionEngines([{ engine: 'omp' }, { engine: 'pi' }]), true)
