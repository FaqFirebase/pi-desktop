import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listMcpServers } from './skills-mcp-handlers'

const ISOLATED_ENV_KEYS = ['HOME', 'PI_CODING_AGENT_DIR', 'OMP_PROFILE', 'PI_PROFILE'] as const

/** Run `fn` with HOME at a fresh folder and Pi's agent directory moved out of it. */
async function withRelocatedPiAgentDir(fn: (paths: { home: string; agentDir: string }) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'pi-mcp-agent-dir-'))
  const saved = new Map(ISOLATED_ENV_KEYS.map((key) => [key, process.env[key]]))
  const home = join(base, 'home')
  const agentDir = join(base, 'relocated-agent')
  process.env.HOME = home
  process.env.PI_CODING_AGENT_DIR = agentDir
  delete process.env.OMP_PROFILE
  delete process.env.PI_PROFILE
  try {
    await fn({ home, agentDir })
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(base, { recursive: true, force: true })
  }
}

async function writeMcpSettings(dir: string, serverName: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  const settings = { mcpServers: { [serverName]: { command: serverName } } }
  await writeFile(join(dir, 'settings.json'), JSON.stringify(settings), 'utf-8')
}

test('listMcpServers reads Pi global servers from PI_CODING_AGENT_DIR', async () => {
  await withRelocatedPiAgentDir(async ({ home, agentDir }) => {
    await writeMcpSettings(agentDir, 'relocated')
    await writeMcpSettings(join(home, '.pi', 'agent'), 'default-location')

    const names = (await listMcpServers(undefined, 'pi')).map((server) => server.name)

    assert.deepEqual(names, ['relocated'])
  })
})

test('listMcpServers under OMP still lists Pi servers from PI_CODING_AGENT_DIR', async () => {
  await withRelocatedPiAgentDir(async ({ home, agentDir }) => {
    await writeMcpSettings(agentDir, 'relocated')
    const ompAgentDir = join(home, '.omp', 'agent')
    await mkdir(ompAgentDir, { recursive: true })
    await writeFile(join(ompAgentDir, 'mcp.json'), JSON.stringify({ mcpServers: { omp: { command: 'omp' } } }), 'utf-8')

    const names = (await listMcpServers(undefined, 'omp')).map((server) => server.name)

    assert.deepEqual(names.sort(), ['omp', 'relocated'])
  })
})
