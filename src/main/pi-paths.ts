import { join } from 'path'
import { isPathWithin } from './path-authorization'
import type { AgentEngineKind } from '../shared/ipc-contracts'

/**
 * Absolute path to Pi's on-disk session store (`~/.pi/agent/sessions`).
 * Centralized so session listing, lineage, and activity aggregation agree.
 */
export function getSessionsRoot(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR ||
    join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.pi', 'agent')
  return join(agentDir, 'sessions')
}

/**
 * Absolute path to OMP's session store (`~/.omp/agent/sessions`).
 *
 * Each engine keeps its own sessions: OMP writes here, Pi writes under
 * `~/.pi`, and neither is pointed at the other's tree. Both stores use the
 * same per-project directory naming and the same JSONL record shape, so the
 * index can read them side by side.
 */
export function getOmpSessionsRoot(): string {
  const agentDir = process.env.OMP_CODING_AGENT_DIR ||
    join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.omp', 'agent')
  return join(agentDir, 'sessions')
}

/**
 * Every store the session index reads, Pi's first so its rows win a tie.
 * Duplicates are dropped so an env var pointing both engines at one directory
 * cannot list the same session twice.
 */
export function getSessionRoots(): string[] {
  return [...new Set([getSessionsRoot(), getOmpSessionsRoot()])]
}

/**
 * The engine that owns a session file: the store it lives in. Pi's store is
 * checked first so a directory shared by both engines (one env var pointing at
 * the other's) resolves the way getSessionRoots orders it. Null means the path
 * is in no store at all, which is also what makes it unauthorized.
 */
export function engineForSessionPath(candidate: string): AgentEngineKind | null {
  if (isPathWithin(getSessionsRoot(), candidate)) return 'pi'
  if (isPathWithin(getOmpSessionsRoot(), candidate)) return 'omp'
  return null
}

/**
 * The engine a start must use, taken from the session file that start is bound
 * to. A fork source outranks a session path because the fork reads the source
 * before it writes anything. Null when the start creates a new session and so
 * has no owner yet, leaving the caller free to use the configured engine.
 *
 * Shared by the runtime launcher and the permission-mode options so both agree
 * on which engine a start belongs to — the tool names differ per engine, so a
 * disagreement sends OMP Pi's tool list.
 */
export function engineForBoundSession(
  bound: { sessionPath?: string; forkSessionPath?: string }
): AgentEngineKind | null {
  const boundSessionPath = bound.forkSessionPath ?? bound.sessionPath
  return boundSessionPath ? engineForSessionPath(boundSessionPath) : null
}

/**
 * Authorization gate for a session path the renderer supplied. A path is
 * acceptable when it sits inside any store the index itself reads; anything
 * else is refused, which is what keeps resume/fork/delete inside the stores.
 */
export function isWithinSessionRoots(candidate: string): boolean {
  return engineForSessionPath(candidate) !== null
}
