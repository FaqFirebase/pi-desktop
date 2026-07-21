/**
 * Permission rules engine for Pi Desktop.
 *
 * Single source of truth shared by:
 * - the bundled Pi extension `pi-desktop-permissions.ts` (loaded by Pi via
 *   jiti, which resolves this relative TS import at runtime), and
 * - the Electron main process (bundled by electron-vite).
 *
 * Must therefore import only from `node:*` — no Electron, no Pi APIs.
 * (Task 3 adds the node:fs / node:path imports when file loading lands —
 * adding them now would trip noUnusedLocals.)
 */
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const PERMISSION_RULES_VERSION = 1
export const PERMISSION_RULES_FILE_NAME = 'permission-rules.json'
export const WORKSPACE_RULES_DIR_NAME = '.pi-desktop'
export const ANY_TOOL = '*'

export type PermissionRuleAction = 'allow' | 'deny'

export interface PermissionRule {
  action: PermissionRuleAction
  tool: string
  match?: string
}

export interface PermissionRulesFile {
  version: typeof PERMISSION_RULES_VERSION
  rules: PermissionRule[]
}

const FILE_KEYS = new Set(['version', 'rules'])
const RULE_KEYS = new Set(['action', 'tool', 'match'])
const RULE_ACTIONS = new Set<PermissionRuleAction>(['allow', 'deny'])

/** Validate untrusted JSON into a PermissionRulesFile. Throws on any problem. */
export function validatePermissionRulesFile(data: unknown): PermissionRulesFile {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('permission rules must be a JSON object')
  }
  const file = data as Record<string, unknown>
  for (const key of Object.keys(file)) {
    if (!FILE_KEYS.has(key)) throw new Error(`unknown key "${key}" in permission rules file`)
  }
  if (file.version !== PERMISSION_RULES_VERSION) {
    throw new Error(`unsupported permission rules version (expected ${PERMISSION_RULES_VERSION})`)
  }
  if (!Array.isArray(file.rules)) throw new Error('"rules" must be an array')

  const rules: PermissionRule[] = file.rules.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`rule ${index + 1} must be an object`)
    }
    const rule = entry as Record<string, unknown>
    for (const key of Object.keys(rule)) {
      if (!RULE_KEYS.has(key)) throw new Error(`unknown key "${key}" in rule ${index + 1}`)
    }
    if (typeof rule.action !== 'string' || !RULE_ACTIONS.has(rule.action as PermissionRuleAction)) {
      throw new Error(`rule ${index + 1}: action must be "allow" or "deny"`)
    }
    if (typeof rule.tool !== 'string' || rule.tool.length === 0) {
      throw new Error(`rule ${index + 1}: tool must be a non-empty string`)
    }
    if (rule.match !== undefined && typeof rule.match !== 'string') {
      throw new Error(`rule ${index + 1}: match must be a string`)
    }
    const validated: PermissionRule = {
      action: rule.action as PermissionRuleAction,
      tool: rule.tool,
    }
    if (rule.match !== undefined) validated.match = rule.match
    return validated
  })

  return { version: PERMISSION_RULES_VERSION, rules }
}

const REGEXP_META = /[.*+?^${}()|[\]\\]/g

function escapeRegExp(text: string): string {
  return text.replace(REGEXP_META, '\\$&')
}

/**
 * Compile a permission glob to an anchored RegExp. `*` matches any sequence
 * of characters (the `s` flag makes `.` span newlines in multi-line
 * commands); everything else is literal.
 */
export function globToRegExp(pattern: string, caseInsensitive: boolean): RegExp {
  const body = pattern.split(ANY_TOOL).map(escapeRegExp).join('.*')
  return new RegExp(`^${body}$`, caseInsensitive ? 'is' : 's')
}

export type PrimaryInputKind = 'command' | 'path' | 'json'

export interface PrimaryInput {
  value: string
  kind: PrimaryInputKind
}

const BASH_TOOL = 'bash'

/**
 * The single string a rule's glob is tested against: the bash command, a file
 * tool's path, or (for anything else) the JSON-stringified input.
 */
export function getPrimaryInput(toolName: string, input: unknown): PrimaryInput {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const data = input as Record<string, unknown>
    if (toolName === BASH_TOOL && typeof data.command === 'string') {
      return { value: data.command, kind: 'command' }
    }
    if (typeof data.path === 'string') {
      return { value: data.path, kind: 'path' }
    }
  }
  return { value: JSON.stringify(input ?? null), kind: 'json' }
}

export type RuleDecision =
  | { decision: 'allow' | 'deny'; rule: PermissionRule }
  | { decision: 'default' }

// Platforms whose default filesystems are case-insensitive; path globs match
// case-insensitively there so a deny on "*.env*" also catches ".ENV".
const CASE_INSENSITIVE_PATH_PLATFORMS = new Set(['win32', 'darwin'])
const BACKSLASH = /\\/g

function ruleMatches(rule: PermissionRule, toolName: string, primary: PrimaryInput, platform: string): boolean {
  if (rule.tool !== ANY_TOOL && rule.tool !== toolName) return false
  if (rule.match === undefined) return true
  let value = primary.value
  let pattern = rule.match
  const caseInsensitive = primary.kind === 'path' && CASE_INSENSITIVE_PATH_PLATFORMS.has(platform)
  if (primary.kind === 'path') {
    value = value.replace(BACKSLASH, '/')
    pattern = pattern.replace(BACKSLASH, '/')
  }
  return globToRegExp(pattern, caseInsensitive).test(value)
}

/** Deny beats allow; rule order in the file is irrelevant. */
export function evaluateRules(
  rules: PermissionRule[],
  toolName: string,
  input: unknown,
  platform: string
): RuleDecision {
  const primary = getPrimaryInput(toolName, input)
  const deny = rules.find((rule) => rule.action === 'deny' && ruleMatches(rule, toolName, primary, platform))
  if (deny) return { decision: 'deny', rule: deny }
  const allow = rules.find((rule) => rule.action === 'allow' && ruleMatches(rule, toolName, primary, platform))
  if (allow) return { decision: 'allow', rule: allow }
  return { decision: 'default' }
}

export type ToolCallDecision =
  | { action: 'block'; reason: string }
  | { action: 'allow' }
  | { action: 'prompt' }

// Tools each ask mode gates when no rule decides first. Mirrors the previous
// shouldConfirm behavior in pi-desktop-permissions.ts exactly.
const ASK_EDITS_GATED_TOOLS = new Set(['edit', 'write', 'bash'])
const ASK_COMMANDS_GATED_TOOLS = new Set(['bash'])

const MODE_ASK_EDITS = 'ask-edits'
const MODE_ASK_COMMANDS = 'ask-commands'

export function decideToolCall(
  mode: string | undefined,
  rules: PermissionRule[],
  toolName: string,
  input: unknown,
  platform: string
): ToolCallDecision {
  const result = evaluateRules(rules, toolName, input, platform)
  if (result.decision === 'deny') {
    const suffix = result.rule.match === undefined ? '' : ` ${result.rule.match}`
    return { action: 'block', reason: `Blocked by permission rule: deny ${result.rule.tool}${suffix}` }
  }
  if (result.decision === 'allow') return { action: 'allow' }
  if (mode === MODE_ASK_EDITS && ASK_EDITS_GATED_TOOLS.has(toolName)) return { action: 'prompt' }
  if (mode === MODE_ASK_COMMANDS && ASK_COMMANDS_GATED_TOOLS.has(toolName)) return { action: 'prompt' }
  return { action: 'allow' }
}

/** Whether the Pi permissions extension must be loaded for this launch. */
export function needsPermissionsExtension(mode: string, hasRulesFile: boolean): boolean {
  return mode === MODE_ASK_EDITS || mode === MODE_ASK_COMMANDS || hasRulesFile
}

export function workspaceRulesPath(cwd: string): string {
  return join(cwd, WORKSPACE_RULES_DIR_NAME, PERMISSION_RULES_FILE_NAME)
}

export interface EffectiveRules {
  rules: PermissionRule[]
  source: 'workspace' | 'global' | 'none'
  error?: string
}

interface CachedRulesFile {
  mtimeMs: number
  rules: PermissionRule[]
  error?: string
}

const rulesFileCache = new Map<string, CachedRulesFile>()

/** Test isolation only. */
export function clearRulesCache(): void {
  rulesFileCache.clear()
}

/**
 * Read + validate one rules file, re-parsing only when its mtime changes.
 * Returns null when the file does not exist (or cannot be stat-ed).
 * A malformed file is cached as "no rules + error" and logged once per mtime.
 */
function loadRulesFile(filePath: string): CachedRulesFile | null {
  let mtimeMs: number
  try {
    mtimeMs = statSync(filePath).mtimeMs
  } catch {
    rulesFileCache.delete(filePath)
    return null
  }

  const cached = rulesFileCache.get(filePath)
  if (cached && cached.mtimeMs === mtimeMs) return cached

  let entry: CachedRulesFile
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'))
    entry = { mtimeMs, rules: validatePermissionRulesFile(parsed).rules }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[pi-desktop] invalid permission rules file ${filePath}: ${message}`)
    entry = { mtimeMs, rules: [], error: message }
  }
  rulesFileCache.set(filePath, entry)
  return entry
}

/**
 * Resolve the effective rules: a valid workspace file (under cwd) fully
 * replaces the global file. A malformed workspace file falls back to the
 * global file (so global deny rules keep applying) and carries the error.
 */
export function loadEffectiveRules(cwd: string | null, globalPath: string | null): EffectiveRules {
  let workspaceError: string | undefined
  if (cwd) {
    const workspace = loadRulesFile(workspaceRulesPath(cwd))
    if (workspace && workspace.error === undefined) {
      return { rules: workspace.rules, source: 'workspace' }
    }
    workspaceError = workspace?.error
  }
  if (globalPath) {
    const global = loadRulesFile(globalPath)
    if (global) {
      const error = workspaceError ?? global.error
      return { rules: global.rules, source: 'global', ...(error ? { error } : {}) }
    }
  }
  return { rules: [], source: 'none', ...(workspaceError ? { error: workspaceError } : {}) }
}
