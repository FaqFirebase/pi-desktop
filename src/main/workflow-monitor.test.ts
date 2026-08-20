import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { test } from 'node:test'
import { getWorkflowRun, listWorkflowRuns } from './workflow-monitor'
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

test('projects persisted workflow runs into safe workspace summaries', async () => {
  const cwd = await mkdtemp(join(homedir(), 'pi-workflow-monitor-'))
  const runsDir = join(homedir(), '.pi', 'workflows', 'projects', projectKey(cwd), 'runs')
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent')
  const safeCwd = `--${resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
  const sessionDir = join(agentDir, 'sessions', safeCwd)
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
