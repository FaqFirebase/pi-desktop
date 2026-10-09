import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPiCli } from './run-pi-cli'
import { getPiCli, setPiExecutableOverride } from '../pi-rpc-manager'
import { describePiStartFailure } from '../pi-binary-resolution'
import { t } from '../../shared/i18n'

const CLI_TIMEOUT_MS = 10_000

test('a package command with no engine installed reports it instead of starting a bare name', async () => {
  // A configured OMP path that does not exist resolves to the bare `omp`
  // fallback. Spawned with the workspace as the working directory, Windows
  // would look that name up in the workspace first.
  const dir = mkdtempSync(join(tmpdir(), 'pi-cli-missing-'))
  const saved = { PATH: process.env.PATH, SHELL: process.env.SHELL }
  try {
    // An empty PATH and no login shell: even a bare spawn could reach no real engine.
    process.env.PATH = dir
    process.env.SHELL = join(dir, 'no-such-shell')
    setPiExecutableOverride(join(dir, 'missing-omp'), 'omp')
    const { failureReason } = getPiCli()
    assert.ok(failureReason, 'the missing engine is a start failure')

    assert.deepEqual(await runPiCli(['--version'], dir, CLI_TIMEOUT_MS), {
      success: false,
      output: describePiStartFailure(failureReason, t),
    })
  } finally {
    setPiExecutableOverride(null, 'auto')
    process.env.PATH = saved.PATH
    if (saved.SHELL === undefined) delete process.env.SHELL
    else process.env.SHELL = saved.SHELL
    rmSync(dir, { recursive: true, force: true })
  }
})
