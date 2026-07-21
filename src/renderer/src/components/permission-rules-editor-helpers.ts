import type { PermissionRule } from '../../../shared/ipc-contracts'

/**
 * Editor-level validation: the only invalid state the row UI can produce is
 * a blank tool (action is a select, match is optional). Full schema
 * validation happens in the main process on save.
 */
export function validateRuleList(rules: PermissionRule[]): string | null {
  for (let i = 0; i < rules.length; i++) {
    if (rules[i].tool.trim().length === 0) {
      return `Rule ${i + 1}: tool is required (use * for any tool)`
    }
  }
  return null
}

export function emptyRule(): PermissionRule {
  return { action: 'allow', tool: '', match: '' }
}
