import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { test } from 'node:test'
import {
  clearWorkflowProjectDiscoveryCache,
  discoverWorkflowProjects,
  getWorkflowRun,
  listWorkflowRuns,
  resolveWorkflowWorkspaces,
} from './workflow-monitor'
import { desanitizeSessionDir, sanitizePath } from './session-paths'
import { pathGroupKey, pathsEqual } from '../shared/path-compare'
import type { Workspace } from '../shared/ipc-contracts'

function projectKey(cwd: string): string {
  const projectPath = resolve(cwd)
  const name = (basename(projectPath) || 'project')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'project'
  return `${name}-${createHash('sha256').update(projectPath).digest('hex').slice(0, 12)}`
}

const SESSION_UUID = '01a01a28-f010-7b29-8312-21ba523d9edf'
const RUN_ID = 'run-hyphenated-abc123'

interface Fixture {
  realCwd: string
  phantomPath: string
  projectDir: string
  runsDir: string
  sessionDir: string
  cleanup: () => Promise<void>
}

/**
 * Create a real project with a HYPHEN in its folder name (the lossy-decode
 * case: `pi-desktop-abc123` desanitizes to `pi\desktop\abc123`), a persisted
 * workflow run keyed under the REAL path, and a session JSONL whose header
 * carries the authoritative real cwd.
 */
async function makeFixture(): Promise<Fixture> {
  const realCwd = await mkdtemp(join(homedir(), 'pi-discovery-'))
  const phantomPath = desanitizeSessionDir(sanitizePath(realCwd))
  const key = projectKey(realCwd)
  const projectDir = join(homedir(), '.pi', 'workflows', 'projects', key)
  const runsDir = join(projectDir, 'runs')
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent')
  const sessionDir = join(agentDir, 'sessions', sanitizePath(realCwd))

  await mkdir(runsDir, { recursive: true })
  await writeFile(join(runsDir, `${RUN_ID}.json`), JSON.stringify({
    runId: RUN_ID,
    workflowName: 'audit',
    sessionId: SESSION_UUID,
    status: 'completed',
    phases: ['scan'],
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    agents: [{ id: 0, label: 'scan files', status: 'done', history: [{ role: 'assistant', kind: 'text', text: 'captured' }] }],
  }))

  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, `2026-01-01T00-00-00-000Z_${SESSION_UUID}.jsonl`), [
    { type: 'session', id: SESSION_UUID, cwd: realCwd },
    { type: 'session_info', name: `workflow:${RUN_ID} scan files` },
    { type: 'message', timestamp: '2026-01-01T00:00:02.000Z', message: { role: 'user', content: [{ type: 'text', text: 'inspect the repo' }] } },
    { type: 'message', timestamp: '2026-01-01T00:00:03.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
  ].map((line) => JSON.stringify(line)).join('\n'))

  return {
    realCwd,
    phantomPath,
    projectDir,
    runsDir,
    sessionDir,
    cleanup: async () => {
      await rm(projectDir, { recursive: true, force: true })
      await rm(sessionDir, { recursive: true, force: true })
      await rm(realCwd, { recursive: true, force: true })
    },
  }
}

const phantomWorkspace = (path: string): Workspace => ({
  id: 'ws-phantom',
  name: 'desktop',
  path,
  createdAt: 0,
  lastActiveAt: 0,
  color: '#fff',
})

test('discovery resolves a hyphenated project from the session header cwd', async () => {
  const fixture = await makeFixture()
  try {
    clearWorkflowProjectDiscoveryCache()
    const discovery = await discoverWorkflowProjects()
    const key = projectKey(fixture.realCwd)
    // The project key is the real cwd's key, never the phantom's.
    assert.equal(discovery.projects.get(key), resolve(fixture.realCwd))
    assert.ok(fixture.phantomPath !== fixture.realCwd)
    // The session-dir map anchors the phantom (lossy) dir name to the real cwd.
    // Keyed case-folded like every other path key on Windows.
    assert.equal(
      discovery.sessionDirCwds.get(pathGroupKey(sanitizePath(fixture.realCwd))),
      resolve(fixture.realCwd)
    )
  } finally {
    await fixture.cleanup()
    clearWorkflowProjectDiscoveryCache()
  }
})

test('a registered workspace holding the phantom path is healed in memory (id preserved)', async () => {
  const fixture = await makeFixture()
  try {
    clearWorkflowProjectDiscoveryCache()
    // The workspace is registered at the LOSSY path — exactly the live bug
    // (workspaces.json had E:\Projects\AI\pi\desktop).
    const registered = [phantomWorkspace(fixture.phantomPath)]
    const resolved = await resolveWorkflowWorkspaces(registered)

    const healed = resolved.find((ws) => ws.id === 'ws-phantom')
    assert.ok(healed, 'registered workspace id is preserved')
    assert.ok(pathsEqual(healed.path, fixture.realCwd), `healed to real cwd, got ${healed.path}`)
    assert.equal(healed.name, basename(fixture.realCwd))

    // The same projection serves list, detail and control routing. Filter to
    // the fixture's workspace — the resolution also includes every other
    // project discovered in the real store.
    const runs = (await listWorkflowRuns(resolved)).filter((run) => run.workspaceId === 'ws-phantom')
    assert.equal(runs.length, 1)
    assert.equal(runs[0].workspaceId, 'ws-phantom')
    assert.equal(runs[0].cwd, resolve(fixture.realCwd))

    const detail = await getWorkflowRun(healed, RUN_ID)
    assert.equal(detail?.workflowName, 'audit')
    // Transcript attaches through the healed cwd (persisted-session, not the
    // degraded run-history fallback).
    assert.equal(detail?.agents[0].transcriptSource, 'persisted-session')
    assert.equal(detail?.agents[0].transcriptComplete, true)
  } finally {
    await fixture.cleanup()
    clearWorkflowProjectDiscoveryCache()
  }
})

test('an unregistered project gets a read-only workflow-<key> projection with the real cwd', async () => {
  const fixture = await makeFixture()
  try {
    clearWorkflowProjectDiscoveryCache()
    const key = projectKey(fixture.realCwd)
    const resolved = await resolveWorkflowWorkspaces([])

    const projection = resolved.find((ws) => ws.id === `workflow-${key}`)
    assert.ok(projection, 'workflow-<key> projection exists')
    assert.ok(pathsEqual(projection.path, fixture.realCwd))
    assert.equal(projection.name, basename(fixture.realCwd))

    const runs = await listWorkflowRuns([projection])
    assert.equal(runs.length, 1)
    assert.equal(runs[0].workspaceId, `workflow-${key}`)
    const detail = await getWorkflowRun(projection, RUN_ID)
    assert.equal(detail?.agents[0].transcriptSource, 'persisted-session')
  } finally {
    await fixture.cleanup()
    clearWorkflowProjectDiscoveryCache()
  }
})

test('an unresolved project is still listable/detail-openable via its display path', async () => {
  const fixture = await makeFixture()
  // Remove the session trace: only the run JSONs remain, so the cwd cannot be
  // recovered — the projection must fall back to a display-only path while the
  // run stays readable (run-history transcript).
  await rm(fixture.sessionDir, { recursive: true, force: true })
  try {
    clearWorkflowProjectDiscoveryCache()
    const key = projectKey(fixture.realCwd)
    const resolved = await resolveWorkflowWorkspaces([])

    const projection = resolved.find((ws) => ws.id === `workflow-${key}`)
    assert.ok(projection, 'unresolved project still gets a projection')
    // Display-only path under the projects dir; the id still pins the key.
    assert.equal(projection.path, join(homedir(), '.pi', 'workflows', 'projects', key))

    const runs = await listWorkflowRuns([projection])
    assert.equal(runs.length, 1)
    assert.equal(runs[0].cwd, projection.path)
    const detail = await getWorkflowRun(projection, RUN_ID)
    assert.equal(detail?.workflowName, 'audit')
    assert.equal(detail?.agents[0].transcriptSource, 'run-history')
  } finally {
    await fixture.cleanup()
    clearWorkflowProjectDiscoveryCache()
  }
})

test('discovery results are cached and reused between polls', async () => {
  const fixture = await makeFixture()
  try {
    clearWorkflowProjectDiscoveryCache()
    const first = await discoverWorkflowProjects()
    const second = await discoverWorkflowProjects()
    // Same cache hit → same Map instances; no re-walk on the next poll.
    assert.equal(second.projects, first.projects)
    assert.equal(second.sessionDirCwds, first.sessionDirCwds)
    clearWorkflowProjectDiscoveryCache()
    const third = await discoverWorkflowProjects()
    assert.notEqual(third.projects, first.projects)
  } finally {
    await fixture.cleanup()
    clearWorkflowProjectDiscoveryCache()
  }
})
