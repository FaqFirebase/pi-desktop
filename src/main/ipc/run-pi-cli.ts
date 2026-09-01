import { execFile } from 'child_process'
import { promisify } from 'util'
import type { AgentEngineKind } from '../../shared/ipc-contracts'
import { buildPiInvocation, getPiCli, getPiCliForEngine } from '../pi-rpc-manager'

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
    // OMP keeps `install` as a Pi-compatible alias but names the other plugin
    // mutations explicitly. Preserve the package panel's existing contract
    // while routing those two verbs to OMP's native commands.
    const cliArgs = cli.kind === 'omp'
      ? args[0] === 'remove'
        ? ['plugin', 'uninstall', ...args.slice(1)]
        : args[0] === 'update'
        ? ['plugin', 'upgrade', ...args.slice(1)]
        : args
      : args
    // Package specs reach this argv from the renderer, and shell:true means
    // Node quotes nothing — buildPiInvocation escapes the whole invocation for
    // the cmd.exe traversal. A spec cmd.exe cannot carry throws here and is
    // reported through the same failure path as any other CLI error below.
    const invocation = buildPiInvocation(cli, cliArgs)
    const { stdout, stderr } = await execFileAsync(invocation.file, invocation.args, {
      cwd,
      timeout,
      env: { ...process.env },
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
      output: output || 'Command failed',
    }
  }
}
