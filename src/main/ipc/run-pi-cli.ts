import { execFile } from 'child_process'
import { promisify } from 'util'
import type { AgentEngineKind } from '../../shared/ipc-contracts'
import { buildPiInvocation, buildPiRunEnv, getPiCli, getPiCliForEngine } from '../pi-rpc-manager'
import { describePiStartFailure } from '../pi-binary-resolution'
import { t } from '../../shared/i18n'

const execFileAsync = promisify(execFile)

// Run a `pi <subcommand>` using the same binary resolved at startup, or the
// binary of an explicitly named engine (the active session's engine can differ
// from the configured default when a session from the other store is open).
// Electron's child processes don't inherit the user's shell PATH, so bare
// `execFileAsync('pi', ...)` would fail with ENOENT on most systems.
export async function runPiCli(
  args: string[],
  cwd: string,
  timeout: number,
  engine?: AgentEngineKind
): Promise<{ success: boolean; output: string }> {
  try {
    const cli = engine ? getPiCliForEngine(engine) : getPiCli()
    // Nothing was found, so the invocation would be a bare name (`pi.cmd`,
    // `omp`, `node`), which Windows looks up in the working directory (the
    // workspace) before PATH. Report the start failure instead.
    if (cli.failureReason) {
      return { success: false, output: describePiStartFailure(cli.failureReason, t) }
    }
    // OMP keeps `install` as a Pi-compatible alias but names removal
    // explicitly. Preserve the package panel's existing contract while routing
    // that verb to OMP's native command. Updates differ per plugin kind under
    // OMP, so package-handlers builds those argv lists itself.
    const cliArgs = cli.kind === 'omp' && args[0] === 'remove'
      ? ['plugin', 'uninstall', ...args.slice(1)]
      : args
    // Package specs reach this argv from the renderer, and shell:true means
    // Node quotes nothing — buildPiInvocation escapes the whole invocation for
    // the cmd.exe traversal. A spec cmd.exe cannot carry throws here and is
    // reported through the same failure path as any other CLI error below.
    const invocation = buildPiInvocation(cli, cliArgs)
    const { stdout, stderr } = await execFileAsync(invocation.file, invocation.args, {
      cwd,
      timeout,
      env: buildPiRunEnv(cli.needsShell),
      // Windows .cmd/.bat shims require shell:true to be invoked.
      shell: cli.needsShell,
    })
    return { success: true, output: stdout + stderr }
  } catch (err) {
    // execFile rejections carry the child's stdout/stderr alongside the
    // message; surface all of it so the CLI's actual error reaches the user
    // instead of a bare "Command failed".
    const e = err as { stdout?: string; stderr?: string; message?: string }
    const output = [e.stdout, e.stderr, e.message].filter(Boolean).join('\n').trim()
    return {
      success: false,
      output: output || t('errors.pi.commandFailedFallback'),
    }
  }
}
