import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { parseEnv } from 'util'
import { appLog } from './app-log'

/** Optional user env file for agent processes, e.g. provider API keys. */
export function piDotenvPath(home: string = homedir()): string {
  return join(home, '.pi', '.env')
}

/**
 * Variables from the env file that the inherited environment does not already
 * set; a real environment variable always wins. A missing file yields none.
 */
export function readPiDotenv(path: string, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  let text: string
  try {
    text = readFileSync(path, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(parseEnv(text))) {
    if (inherited[key] === undefined) out[key] = value
  }
  return out
}

/**
 * `readPiDotenv` for the user's env file against the app's own environment, for
 * processes the app spawns (every Pi or OMP run, the integrated terminal) and
 * for the diagnostics provider-key check. An unreadable file is
 * logged and yields none. The log never carries the file's values.
 */
export function loadPiDotenv(path: string = piDotenvPath()): NodeJS.ProcessEnv {
  try {
    return readPiDotenv(path, process.env)
  } catch (err) {
    appLog.warn('pi', `Could not read ${path}`, err)
    return {}
  }
}

/**
 * The environment every agent process runs with: the user's env file under the
 * app's own (see buildPiRunEnv). Whatever the app resolves from the agent's
 * environment (agent directories, the OMP profile, provider keys) reads this,
 * so the app and the agent it starts agree.
 */
export function agentEnv(): NodeJS.ProcessEnv {
  return { ...loadPiDotenv(), ...process.env }
}
