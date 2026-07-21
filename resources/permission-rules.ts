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
