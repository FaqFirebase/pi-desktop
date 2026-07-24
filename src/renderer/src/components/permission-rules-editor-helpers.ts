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

/**
 * Whether Save may write a scope's rules file: the user took ownership via an
 * edit/import (draft), or the file already exists and loaded cleanly. Guards
 * against creating an unrequested workspace file (which would override global
 * rules with []) and against clobbering a corrupt file (see settings-panel
 * load-gating comment).
 */
export function shouldPersistScope(
  draft: PermissionRule[] | null,
  loaded: boolean,
  exists: boolean
): boolean {
  return draft !== null || (loaded && exists)
}
