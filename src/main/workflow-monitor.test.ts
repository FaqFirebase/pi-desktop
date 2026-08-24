import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { test } from 'node:test'
import { GUI_DATA_ENV_VAR } from './app-data-paths'
import { appLog } from './app-log'
import {
  clearPersistedSessionCache,
  getWorkflowRun,
  listWorkflowRuns,
  persistedSessionCacheStats,
  setPersistedSessionCacheBudget,
  MAX_TRANSCRIPT_FILES_SCANNED,
} from './workflow-monitor'
import type { Workspace } from '../shared/ipc-contracts'

const AGENT_DIR_ENV = 'PI_CODING_AGENT_DIR'

// The transcript-scan warning goes through the app log, whose path is resolved
// on its first entry — set before any test runs, so neither the log nor its
// debounced file write touches the real GUI data dir.
process.env[GUI_DATA_ENV_VAR] = join(tmpdir(), `pi-workflow-monitor-log-${process.pid}`)

function projectKey(cwd: string): string {
  const projectPath = resolve(cwd)
  const name = (basename(projectPath) || 'project')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'project'
  return `${name}-${createHash('sha256').update(projectPath).digest('hex').slice(0, 12)}`
}

/** Mirrors workflowSessionsDir: Pi's per-cwd session directory. */
function sessionDirFor(cwd: string, agentDir: string): string {
  const safeCwd = `--${resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
  return join(agentDir, 'sessions', safeCwd)
}

interface AgentFixture {
  id: number
  label: string
  prompt?: string
}

interface TranscriptFixture {
  workspace: Workspace
  sessionDir: string
  cleanup: () => Promise<void>
}

/**
 * A self-contained project: the run JSON goes in the project-local
 * `.pi/workflows/runs` dir and the session store is redirected into the
 * fixture, so these cases never read or write the real `~/.pi` store.
 */
async function makeTranscriptFixture(runId: string, agents: AgentFixture[]): Promise<TranscriptFixture> {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-workflow-transcript-'))
  const previousAgentDir = process.env[AGENT_DIR_ENV]
  const agentDir = join(cwd, 'agent')
  process.env[AGENT_DIR_ENV] = agentDir

  const runsDir = join(cwd, '.pi', 'workflows', 'runs')
  await mkdir(runsDir, { recursive: true })
  await writeFile(join(runsDir, `${runId}.json`), JSON.stringify({
    runId,
    workflowName: 'audit',
    status: 'completed',
    phases: ['scan'],
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    agents: agents.map((agent) => ({ ...agent, status: 'done' })),
  }))

  const sessionDir = sessionDirFor(cwd, agentDir)
  await mkdir(sessionDir, { recursive: true })

  return {
    workspace: {
      id: 'ws-transcript',
      name: 'Transcript',
      path: cwd,
      createdAt: 0,
      lastActiveAt: 0,
      color: '#fff',
    },
    sessionDir,
    cleanup: async () => {
      if (previousAgentDir === undefined) delete process.env[AGENT_DIR_ENV]
      else process.env[AGENT_DIR_ENV] = previousAgentDir
      await rm(cwd, { recursive: true, force: true })
    },
  }
}

/** One persisted Pi session: header, `session_info` name, then messages. */
function sessionLines(sessionName: string, messages: Array<{ role: string; text: string }>): string {
  return [
    { type: 'session', id: sessionName, cwd: 'unused' },
    { type: 'session_info', name: sessionName },
    ...messages.map((message, index) => ({
      type: 'message',
      timestamp: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
      message: { role: message.role, content: [{ type: 'text', text: message.text }] },
    })),
  ].map((line) => JSON.stringify(line)).join('\n')
}

test('projects persisted workflow runs into safe workspace summaries', async () => {
  const cwd = await mkdtemp(join(homedir(), 'pi-workflow-monitor-'))
  const runsDir = join(homedir(), '.pi', 'workflows', 'projects', projectKey(cwd), 'runs')
  const agentDir = process.env[AGENT_DIR_ENV] || join(homedir(), '.pi', 'agent')
  const sessionDir = sessionDirFor(cwd, agentDir)
  const workspace: Workspace = {
    id: 'ws-workflow-test',
    name: 'Workflow Test',
    path: cwd,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    color: '#fff',
  }

  try {
    await mkdir(runsDir, { recursive: true })
    await writeFile(join(runsDir, 'run-1.json'), JSON.stringify({
      runId: 'run-1',
      workflowName: 'audit',
      status: 'running',
      phases: ['scan', 'verify'],
      currentPhase: 'scan',
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
      script: 'do not expose this',
      result: { secret: 'do not expose this' },
      agents: [{ id: 0, label: 'scan files', phase: 'scan', status: 'running', prompt: 'private prompt', tokens: 12, history: [{ role: 'assistant', kind: 'text', text: 'captured' }] }],
    }))

    const [run] = await listWorkflowRuns([workspace])
    assert.equal(run.workflowName, 'audit')
    assert.equal(run.workspaceId, workspace.id)
    assert.equal(run.currentPhase, 'scan')
    assert.deepEqual(run.agents[0], {
      id: 0,
      label: 'scan files',
      phase: 'scan',
      status: 'running',
      hasHistory: true,
      tokens: 12,
    })
    assert.equal('script' in run, false)
    assert.equal('result' in run, false)

    await mkdir(sessionDir, { recursive: true })
    await writeFile(join(sessionDir, 'workflow-agent.jsonl'), [
      { type: 'session', id: 'session-1', cwd },
      { type: 'session_info', name: 'workflow:run-1 scan files' },
      { type: 'message', timestamp: '2026-01-01T00:00:02.000Z', message: { role: 'user', content: [{ type: 'text', text: 'private prompt' }] } },
      { type: 'message', timestamp: '2026-01-01T00:00:03.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'I will inspect the files.' }, { type: 'toolCall', name: 'bash', arguments: { command: 'npm test' } }] } },
      { type: 'message', timestamp: '2026-01-01T00:00:04.000Z', message: { role: 'toolResult', toolName: 'bash', content: [{ type: 'text', text: 'all tests passed' }] } },
    ].map((line) => JSON.stringify(line)).join('\n'))

    const full = await getWorkflowRun(workspace, 'run-1')
    assert.equal(full?.agents[0].transcriptSource, 'persisted-session')
    assert.equal(full?.agents[0].transcriptComplete, true)
    assert.equal(full?.agents[0].history.some((entry) => entry.toolName === 'bash'), true)

    await rm(sessionDir, { recursive: true, force: true })
    const detail = await getWorkflowRun(workspace, 'run-1')
    assert.equal(detail?.script, 'do not expose this')
    assert.equal(detail?.agents[0].transcriptSource, 'run-history')
    assert.equal(detail?.agents[0].transcriptComplete, false)
    assert.equal(detail?.agents[0].prompt, 'private prompt')
  } finally {
    await rm(join(homedir(), '.pi', 'workflows', 'projects', projectKey(cwd)), { recursive: true, force: true })
    await rm(sessionDir, { recursive: true, force: true })
    await rm(cwd, { recursive: true, force: true })
  }
})

// ─── Transcript matching ─────────────────────────────────────────────────────

test('an agent never inherits the transcript of a session whose name merely starts with its label', async () => {
  const runId = 'run-label-prefix'
  const fixture = await makeTranscriptFixture(runId, [
    { id: 0, label: 'build', prompt: 'compile the app' },
    { id: 1, label: 'build extras', prompt: 'compile the extras' },
  ])
  try {
    // Only the second agent persisted a session. Its name starts with the
    // FIRST agent's label, which must not be enough to claim it.
    await writeFile(
      join(fixture.sessionDir, '2026-01-01T00-00-01-000Z_extras.jsonl'),
      sessionLines(`workflow:${runId} build extras`, [
        { role: 'user', text: 'compile the extras' },
        { role: 'assistant', text: 'extras are built' },
      ])
    )

    const detail = await getWorkflowRun(fixture.workspace, runId)
    const build = detail?.agents.find((agent) => agent.label === 'build')
    const extras = detail?.agents.find((agent) => agent.label === 'build extras')
    assert.equal(extras?.transcriptSource, 'persisted-session')
    assert.equal(extras?.transcriptComplete, true)
    assert.equal(build?.transcriptSource, 'none')
    assert.equal(build?.transcriptComplete, false)
    assert.deepEqual(build?.history, [])
  } finally {
    await fixture.cleanup()
  }
})

test('two agents sharing one label are separated by their prompts instead of losing both transcripts', async () => {
  const runId = 'run-shared-label'
  const fixture = await makeTranscriptFixture(runId, [
    { id: 0, label: 'build', prompt: 'compile the app' },
    { id: 1, label: 'build', prompt: 'compile the docs' },
  ])
  try {
    await writeFile(
      join(fixture.sessionDir, '2026-01-01T00-00-01-000Z_app.jsonl'),
      sessionLines(`workflow:${runId} build`, [
        { role: 'user', text: 'compile the app' },
        { role: 'assistant', text: 'the app is built' },
      ])
    )
    await writeFile(
      join(fixture.sessionDir, '2026-01-01T00-00-02-000Z_docs.jsonl'),
      sessionLines(`workflow:${runId} build`, [
        { role: 'user', text: 'compile the docs' },
        { role: 'assistant', text: 'the docs are built' },
      ])
    )

    const detail = await getWorkflowRun(fixture.workspace, runId)
    const [app, docs] = detail?.agents ?? []
    assert.equal(app?.transcriptSource, 'persisted-session')
    assert.equal(docs?.transcriptSource, 'persisted-session')
    // Each agent gets ITS OWN session, not the other's.
    assert.ok(app.history.some((entry) => entry.text === 'the app is built'))
    assert.ok(!app.history.some((entry) => entry.text === 'the docs are built'))
    assert.ok(docs.history.some((entry) => entry.text === 'the docs are built'))
    assert.ok(!docs.history.some((entry) => entry.text === 'the app is built'))
  } finally {
    await fixture.cleanup()
  }
})

test('the opening prompt still identifies a session past the history window and the entry cap', async () => {
  const runId = 'run-long-session'
  // Longer than MAX_ENTRY_CHARS (20k), so the persisted copy of the prompt is
  // truncated: an unbounded needle could never be found inside it.
  const longPrompt = (name: string): string => `${name} ${'x'.repeat(25_000)}`
  // More than MAX_HISTORY_ENTRIES (150), so the opening user message falls out
  // of the retained history window.
  const trailing = (name: string): Array<{ role: string; text: string }> =>
    Array.from({ length: 200 }, (_, index) => ({ role: 'assistant', text: `${name} step ${index}` }))
  const fixture = await makeTranscriptFixture(runId, [
    { id: 0, label: 'alpha', prompt: longPrompt('alpha') },
    { id: 1, label: 'beta', prompt: longPrompt('beta') },
  ])
  try {
    // The session names carry no label, so only the prompt can match.
    await writeFile(
      join(fixture.sessionDir, '2026-01-01T00-00-01-000Z_alpha.jsonl'),
      sessionLines(`workflow:${runId} agent-0`, [
        { role: 'user', text: longPrompt('alpha') },
        ...trailing('alpha'),
      ])
    )
    await writeFile(
      join(fixture.sessionDir, '2026-01-01T00-00-02-000Z_beta.jsonl'),
      sessionLines(`workflow:${runId} agent-1`, [
        { role: 'user', text: longPrompt('beta') },
        ...trailing('beta'),
      ])
    )

    const detail = await getWorkflowRun(fixture.workspace, runId)
    const [alpha, beta] = detail?.agents ?? []
    assert.equal(alpha?.transcriptSource, 'persisted-session')
    assert.equal(beta?.transcriptSource, 'persisted-session')
    // The window really did drop the opening user message.
    assert.ok(!alpha.history.some((entry) => entry.role === 'user'))
    assert.ok(alpha.history.some((entry) => entry.text === 'alpha step 199'))
    assert.ok(!alpha.history.some((entry) => entry.text === 'beta step 199'))
    assert.ok(beta.history.some((entry) => entry.text === 'beta step 199'))
  } finally {
    await fixture.cleanup()
  }
})

test('the transcript scan is capped, reads the newest sessions first and reports the truncation', async () => {
  const runId = 'run-capped-scan'
  const fixture = await makeTranscriptFixture(runId, [{ id: 0, label: 'scan', prompt: 'scan the repo' }])
  const overflow = MAX_TRANSCRIPT_FILES_SCANNED + 20
  try {
    // More sessions than the cap allows, all belonging to older runs.
    await Promise.all(Array.from({ length: overflow }, (_, index) => writeFile(
      join(fixture.sessionDir, `2020-01-01T00-00-00-${String(index).padStart(3, '0')}Z_old.jsonl`),
      sessionLines(`workflow:run-older-${index} scan`, [{ role: 'user', text: 'an older run' }])
    )))
    // The run's own session is the newest one on disk.
    await writeFile(
      join(fixture.sessionDir, '2099-01-01T00-00-00-000Z_current.jsonl'),
      sessionLines(`workflow:${runId} scan`, [
        { role: 'user', text: 'scan the repo' },
        { role: 'assistant', text: 'the repo is scanned' },
      ])
    )

    const detail = await getWorkflowRun(fixture.workspace, runId)
    // Reachable only because the scan is ordered newest-first.
    assert.equal(detail?.agents[0].transcriptSource, 'persisted-session')
    assert.ok(detail?.agents[0].history.some((entry) => entry.text === 'the repo is scanned'))

    const warning = appLog.getRecent().find(
      (entry) => entry.level === 'warn' && entry.detail?.includes(fixture.sessionDir)
    )
    assert.ok(warning, 'the truncated scan is surfaced in the app log')
    assert.match(warning.message, new RegExp(`${MAX_TRANSCRIPT_FILES_SCANNED} newest of ${overflow + 1}`))
  } finally {
    await fixture.cleanup()
  }
})

// ─── Persisted-session cache ─────────────────────────────────────────────────

test('the persisted-session cache is bounded by bytes and evicts least-recently-used first', async () => {
  const runId = 'run-cache'
  const fixture = await makeTranscriptFixture(runId, [{ id: 0, label: 'scan', prompt: 'scan the repo' }])
  clearPersistedSessionCache()
  try {
    await writeFile(
      join(fixture.sessionDir, '2020-01-01T00-00-00-000Z_big.jsonl'),
      sessionLines(`workflow:${runId} scan`, [
        { role: 'user', text: 'scan the repo' },
        ...Array.from({ length: 50 }, (_, index) => ({ role: 'assistant', text: `${'y'.repeat(500)} ${index}` })),
      ])
    )
    await getWorkflowRun(fixture.workspace, runId)
    const big = persistedSessionCacheStats()
    assert.equal(big.entries, 1)

    // A newer session of another run: the newest-first scan reads it FIRST, so
    // it is the least recently used entry once the scan finishes.
    await writeFile(
      join(fixture.sessionDir, '2099-01-01T00-00-00-000Z_small.jsonl'),
      sessionLines('workflow:run-other scan', [{ role: 'user', text: 'another run' }])
    )
    await getWorkflowRun(fixture.workspace, runId)
    const both = persistedSessionCacheStats()
    assert.equal(both.entries, 2)
    assert.ok(both.bytes > big.bytes, 'the second transcript is accounted for')

    // Re-reading unchanged files is a cache hit: nothing is counted twice.
    await getWorkflowRun(fixture.workspace, runId)
    assert.deepEqual(persistedSessionCacheStats(), both)

    // Room for the big transcript only: the coldest entry goes, not the largest.
    setPersistedSessionCacheBudget(big.bytes)
    assert.deepEqual(persistedSessionCacheStats(), big)

    clearPersistedSessionCache()
    assert.deepEqual(persistedSessionCacheStats(), { entries: 0, bytes: 0 })
  } finally {
    clearPersistedSessionCache()
    await fixture.cleanup()
  }
})
