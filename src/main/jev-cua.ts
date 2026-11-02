import type { ComputerBackend, CuaJudgment } from '../shared/ipc-contracts'

/**
 * Jev (TypeSafe System One) judgment for Computer Use requests.
 *
 * The HTTP API (https://docs.typesafe.ai/api/system-one) does not generate
 * text: it answers typed *questions* evaluated in parallel against a *state*.
 * One request asks two questions over the user's sentence — a Noul (does the
 * request need a GUI at all?) and a Choice (which backend fits?) — and the
 * answers are mapped onto the shared CuaJudgment shape. Jev returns
 * probabilities, not prose, so `reason` is a machine-generated summary of
 * those probabilities.
 *
 * Degradation is honest and deterministic: without an API key, or on any
 * network/HTTP/parse failure, the judgment is confidence 0 with
 * `reason: 'jev-unavailable'` — never a blocking error, never a fake success.
 */

const JEV_SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone'
const JEV_MODEL = 'jev-latest'
const JEV_TIMEOUT_MS = 8000

/** Noul probability at or above which `needsComputer` becomes true. */
const NOUL_TRUE_THRESHOLD = 0.5

const COMPUTER_BACKEND_KEYS = {
  'main-os': true,
  'proxmox-vm': true,
  'docker-host': true,
  'docker-vm': true,
  auto: true,
} as const satisfies Record<ComputerBackend, true>

function isComputerBackend(value: unknown): value is ComputerBackend {
  return typeof value === 'string' && Object.hasOwn(COMPUTER_BACKEND_KEYS, value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A probability the API contract promises: finite number in [0, 1], else null. */
function toProbability(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null
}

/** Deterministic stand-in when Jev cannot answer; confidence 0 marks it as non-authoritative. */
function jevUnavailableJudgment(): CuaJudgment {
  return { needsComputer: true, backend: 'docker-vm', confidence: 0, reason: 'jev-unavailable' }
}

/**
 * Strict validation of a CuaJudgment-shaped value. Returns a normalized copy
 * (unknown keys are dropped), throws TypeError on any violation.
 */
export function parseCuaJudgment(raw: unknown): CuaJudgment {
  if (!isRecord(raw)) throw new TypeError('CuaJudgment must be an object')

  if (typeof raw.needsComputer !== 'boolean') {
    throw new TypeError('CuaJudgment.needsComputer must be a boolean')
  }
  if (!isComputerBackend(raw.backend)) {
    throw new TypeError(`CuaJudgment.backend must be a ComputerBackend, got ${String(raw.backend)}`)
  }
  const confidence = toProbability(raw.confidence)
  if (confidence === null) {
    throw new TypeError('CuaJudgment.confidence must be a finite number between 0 and 1')
  }
  if (raw.reason !== undefined && typeof raw.reason !== 'string') {
    throw new TypeError('CuaJudgment.reason must be a string when present')
  }

  const judgment: CuaJudgment = {
    needsComputer: raw.needsComputer,
    backend: raw.backend,
    confidence,
  }
  if (raw.reason !== undefined) judgment.reason = raw.reason
  return judgment
}

/** The two answers, keyed by the question names sent in the request. */
function judgmentFromSystemOneResponse(body: unknown): CuaJudgment {
  if (!isRecord(body) || !isRecord(body.answers)) {
    throw new TypeError('Jev response has no answers object')
  }

  const needs = body.answers.needsComputer
  if (!isRecord(needs) || needs.type !== 'noul') throw new TypeError('needsComputer answer is not a noul')
  const noul = toProbability(needs.noul)
  if (noul === null) throw new TypeError('needsComputer noul is not a probability')

  const pick = body.answers.backend
  if (!isRecord(pick) || pick.type !== 'choice') throw new TypeError('backend answer is not a choice')
  if (!isComputerBackend(pick.choice)) {
    throw new TypeError(`Jev chose an unknown backend: ${String(pick.choice)}`)
  }
  const confidence = toProbability(pick.confidence)
  if (confidence === null) throw new TypeError('backend confidence is not a probability')

  return parseCuaJudgment({
    needsComputer: noul >= NOUL_TRUE_THRESHOLD,
    backend: pick.choice,
    confidence,
    reason: `jev: needsComputer ${noul.toFixed(2)}; backend ${pick.choice} at ${confidence.toFixed(2)}`,
  })
}

// The question text is what Jev sees; the state is the user's own sentence.
// Backend descriptions mirror src/shared/ipc-contracts.ts (Computer Panel).
function buildSystemOneBody(request: string): string {
  return JSON.stringify({
    model: JEV_MODEL,
    state: { userRequest: request },
    questions: {
      needsComputer: {
        type: 'noul',
        instructions:
          'Does carrying out the request in `userRequest` require operating a graphical desktop ' +
          'application (clicking, typing into, or reading a GUI window), rather than being handled ' +
          'entirely through conversation, code, files, or headless commands?',
        criteria: {
          true:
            'The task needs a visible GUI: an app with no usable CLI or API, a desktop-only workflow, ' +
            'or verification by looking at a screen.',
          false:
            'No GUI is needed: answering questions, writing or reading code, editing files, or calling ' +
            'CLIs/APIs is enough to complete the task.',
        },
      },
      backend: {
        type: 'choice',
        instructions:
          'Which computer should host the GUI work for the request in `userRequest`?',
        criteria: {
          'main-os':
            'The Windows desktop of this very PC (the user’s own machine). Use when the task concerns ' +
            'files, installed apps, hardware, or accounts on this PC itself.',
          'proxmox-vm':
            'The Linux desktop of the dedicated Cua VM hosted on the local Proxmox server. Use when the ' +
            'task needs a full persistent Linux desktop rather than a throwaway sandbox.',
          'docker-host':
            'A disposable Linux container started by the Docker engine on this PC. Use for isolated ' +
            'Linux GUI tasks that should not touch the VM or the Windows desktop.',
          'docker-vm':
            'A Linux container started by the Cua CLI on the Cua VM: a clean sandbox off the user’s ' +
            'own machine. The safe default for generic GUI automation tasks.',
        },
      },
    },
  })
}

/**
 * The minimal fetch surface judgeCuaUseRequest uses. Node's global fetch
 * satisfies it; tests inject a stub.
 */
export interface JevFetchInit {
  method: 'POST'
  headers: Record<string, string>
  body: string
  signal?: AbortSignal
}

export interface JevFetchResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
}

export type JevFetch = (url: string, init: JevFetchInit) => Promise<JevFetchResponse>

/**
 * Ask Jev whether the user request needs a computer and which backend fits.
 * Never rejects: every failure path returns the deterministic
 * `jev-unavailable` judgment (confidence 0).
 */
export async function judgeCuaUseRequest(
  request: string,
  apiKey: string | null,
  fetchImpl: JevFetch = globalThis.fetch as unknown as JevFetch,
): Promise<CuaJudgment> {
  if (!apiKey) return jevUnavailableJudgment()

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), JEV_TIMEOUT_MS)
  try {
    const response = await fetchImpl(JEV_SYSTEM_ONE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: buildSystemOneBody(request),
      signal: controller.signal,
    })
    if (!response.ok) return jevUnavailableJudgment()
    return judgmentFromSystemOneResponse(await response.json())
  } catch {
    // Network, HTTP, timeout or shape failure: degrade, never block the user.
    return jevUnavailableJudgment()
  } finally {
    clearTimeout(timer)
  }
}
