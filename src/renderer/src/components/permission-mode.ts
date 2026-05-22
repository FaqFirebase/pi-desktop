import type { PermissionMode } from '../../../shared/ipc-contracts'

export const DEFAULT_PERMISSION_MODE: PermissionMode = 'ask-edits'

export const PERMISSION_MODE_OPTIONS: Array<{
  value: PermissionMode
  label: string
  description: string
  tone: 'safe' | 'review' | 'command' | 'trusted'
}> = [
  {
    value: 'plan-readonly',
    label: 'Plan / Read-only',
    description: 'PI can inspect and propose, but should not edit files or run risky commands.',
    tone: 'safe',
  },
  {
    value: 'ask-edits',
    label: 'Ask before edits',
    description: 'PI should request approval before changing files.',
    tone: 'review',
  },
  {
    value: 'ask-commands',
    label: 'Ask before commands',
    description: 'PI should request approval before running shell commands.',
    tone: 'command',
  },
  {
    value: 'trusted',
    label: 'Trusted',
    description: 'PI may proceed with fewer prompts for workflows you trust.',
    tone: 'trusted',
  },
]

const PERMISSION_MODE_VALUES = new Set<PermissionMode>(
  PERMISSION_MODE_OPTIONS.map((option) => option.value)
)

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && PERMISSION_MODE_VALUES.has(value as PermissionMode)
}

export function getPermissionModeLabel(mode: PermissionMode): string {
  return PERMISSION_MODE_OPTIONS.find((option) => option.value === mode)?.label ?? 'Ask before edits'
}
