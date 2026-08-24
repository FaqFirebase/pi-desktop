import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'path'
import {
  engineForBoundSession,
  engineForSessionPath,
  getSessionsRoot,
  getOmpSessionsRoot,
  getSessionRoots,
  isWithinSessionRoots,
} from './pi-paths'

/**
 * Each engine keeps its sessions in its own store, so a session started under
 * OMP never reaches Pi's tree. The index has to read both or those sessions
 * are invisible in the Sessions tab, and it has to remember which store a row
 * came from or the app cannot relaunch the engine that owns it.
 */

function withEnv(vars: Record<string, string | undefined>, run: () => void): void {
  const saved = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    run()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('the two engines resolve to different session stores', () => {
  withEnv({ HOME: '/home/tester', PI_CODING_AGENT_DIR: undefined, OMP_CODING_AGENT_DIR: undefined }, () => {
    assert.equal(getSessionsRoot(), join('/home/tester', '.pi', 'agent', 'sessions'))
    assert.equal(getOmpSessionsRoot(), join('/home/tester', '.omp', 'agent', 'sessions'))
    assert.notEqual(getSessionsRoot(), getOmpSessionsRoot())
  })
})

test('the index reads both stores, Pi first', () => {
  withEnv({ HOME: '/home/tester', PI_CODING_AGENT_DIR: undefined, OMP_CODING_AGENT_DIR: undefined }, () => {
    assert.deepEqual(getSessionRoots(), [getSessionsRoot(), getOmpSessionsRoot()])
  })
})

test('one directory shared by both engines is only listed once', () => {
  withEnv({ HOME: '/home/tester', PI_CODING_AGENT_DIR: '/shared/agent', OMP_CODING_AGENT_DIR: '/shared/agent' }, () => {
    assert.deepEqual(getSessionRoots(), [join('/shared/agent', 'sessions')])
  })
})

test('a session file is owned by the engine whose store holds it', () => {
  withEnv({ HOME: '/home/tester', PI_CODING_AGENT_DIR: undefined, OMP_CODING_AGENT_DIR: undefined }, () => {
    assert.equal(engineForSessionPath(join(getSessionsRoot(), '--home-tester--', 'a.jsonl')), 'pi')
    assert.equal(engineForSessionPath(join(getOmpSessionsRoot(), '--home-tester--', 'b.jsonl')), 'omp')
    // Nested subagent transcripts belong to the same engine as their parent.
    assert.equal(engineForSessionPath(join(getOmpSessionsRoot(), '--p--', 'run', 'c.jsonl')), 'omp')
  })
})

test('a session outside every store has no owning engine', () => {
  withEnv({ HOME: '/home/tester', PI_CODING_AGENT_DIR: undefined, OMP_CODING_AGENT_DIR: undefined }, () => {
    assert.equal(engineForSessionPath('/tmp/loose.jsonl'), null)
    assert.equal(engineForSessionPath(join('/home/tester', '.pi', 'agent', 'auth.json')), null)
  })
})

test('one directory shared by both engines is owned by Pi', () => {
  withEnv({ HOME: '/home/tester', PI_CODING_AGENT_DIR: '/shared/agent', OMP_CODING_AGENT_DIR: '/shared/agent' }, () => {
    // Same tie-break as getSessionRoots, so the row's engine matches the root
    // the index listed it from.
    assert.equal(engineForSessionPath(join('/shared/agent', 'sessions', '--p--', 'a.jsonl')), 'pi')
  })
})

test('a session created by OMP is authorized, not just a Pi one', () => {
  withEnv({ HOME: '/home/tester', PI_CODING_AGENT_DIR: undefined, OMP_CODING_AGENT_DIR: undefined }, () => {
    const piSession = join(getSessionsRoot(), '--home-tester--', 'a.jsonl')
    const ompSession = join(getOmpSessionsRoot(), '--home-tester--', 'b.jsonl')

    assert.equal(isWithinSessionRoots(piSession), true)
    // This is the regression: before the index read both stores, resuming or
    // deleting an OMP session was refused as being outside the session root.
    assert.equal(isWithinSessionRoots(ompSession), true)
  })
})

test('a path outside every store is still refused', () => {
  withEnv({ HOME: '/home/tester', PI_CODING_AGENT_DIR: undefined, OMP_CODING_AGENT_DIR: undefined }, () => {
    assert.equal(isWithinSessionRoots('/etc/passwd'), false)
    assert.equal(isWithinSessionRoots(join('/home/tester', '.pi', 'agent', 'auth.json')), false)
    // A sibling directory whose name merely starts with the root must not pass.
    assert.equal(isWithinSessionRoots(join('/home/tester', '.omp', 'agent', 'sessions-backup', 'x.jsonl')), false)
  })
})

/**
 * The runtime launcher and the permission-mode options both have to name the
 * same engine for one start. If they disagree, a start runs OMP while being
 * given Pi's plan-mode tool names, so plan mode loses the tools it should allow.
 */

test('a start bound to an OMP session belongs to OMP', () => {
  withEnv({ HOME: '/home/tester', PI_CODING_AGENT_DIR: undefined, OMP_CODING_AGENT_DIR: undefined }, () => {
    const ompSession = join(getOmpSessionsRoot(), '--p--', 'a.jsonl')
    assert.equal(engineForBoundSession({ sessionPath: ompSession }), 'omp')
    assert.equal(engineForBoundSession({ sessionPath: join(getSessionsRoot(), '--p--', 'a.jsonl') }), 'pi')
  })
})

test('a fork reads its source, so the source engine wins over the new file', () => {
  withEnv({ HOME: '/home/tester', PI_CODING_AGENT_DIR: undefined, OMP_CODING_AGENT_DIR: undefined }, () => {
    assert.equal(
      engineForBoundSession({
        sessionPath: join(getSessionsRoot(), '--p--', 'new.jsonl'),
        forkSessionPath: join(getOmpSessionsRoot(), '--p--', 'source.jsonl'),
      }),
      'omp'
    )
  })
})

test('a start with no session has no owning engine', () => {
  withEnv({ HOME: '/home/tester', PI_CODING_AGENT_DIR: undefined, OMP_CODING_AGENT_DIR: undefined }, () => {
    // A brand-new session is free to use whichever engine is configured.
    assert.equal(engineForBoundSession({}), null)
    assert.equal(engineForBoundSession({ sessionPath: '/tmp/loose.jsonl' }), null)
  })
})
