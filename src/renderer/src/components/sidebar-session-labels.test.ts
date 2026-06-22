import assert from 'node:assert/strict'
import { getSessionRowLabels } from './sidebar-session-labels'

const namelessCurrentWorkspace = {
  name: null,
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
