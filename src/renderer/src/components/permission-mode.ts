import type { TFunction } from 'i18next'
import type { PermissionMode } from '../../../shared/ipc-contracts'
import { t } from '../../../shared/i18n'

export const DEFAULT_PERMISSION_MODE: PermissionMode = 'ask-edits'

export const PERMISSION_MODE_OPTIONS: Array<{
  value: PermissionMode
  tone: 'safe' | 'review' | 'command' | 'trusted'
}> = [
  { value: 'plan-readonly', tone: 'safe' },
  { value: 'ask-edits', tone: 'review' },
  { value: 'ask-commands', tone: 'command' },
  { value: 'trusted', tone: 'trusted' },
]

export { isPermissionMode } from '../../../shared/permission-mode'

/**
 * Explicit key maps, exported so other components (`permission-selector.tsx`,
 * `composer-permission-menu.tsx`) can look up the same literal keys with
 * their own `useTranslation()` hook's `t` — calling `getPermissionModeLabel`
 * below instead would bake in this module's shared, non-reactive `t` and the
 * label would not update on a language change. (A template-literal key on a
 * directly union-typed parameter, as used here, is resolved by
 * `i18next-cli`'s extractor without trouble — verified against
 * `permissionMode.${mode}.label`; the map exists for the multi-component
 * reactivity reason above, not an extraction limitation.)
 */
export const PERMISSION_MODE_LABEL_KEYS = {
  'plan-readonly': 'permissionMode.plan-readonly.label',
  'ask-edits': 'permissionMode.ask-edits.label',
  'ask-commands': 'permissionMode.ask-commands.label',
  trusted: 'permissionMode.trusted.label',
} as const satisfies Record<PermissionMode, string>

export const PERMISSION_MODE_DESCRIPTION_KEYS = {
  'plan-readonly': 'permissionMode.plan-readonly.description',
  'ask-edits': 'permissionMode.ask-edits.description',
  'ask-commands': 'permissionMode.ask-commands.description',
  trusted: 'permissionMode.trusted.description',
} as const satisfies Record<PermissionMode, string>

export function getPermissionModeLabel(mode: PermissionMode): string {
  return t(PERMISSION_MODE_LABEL_KEYS[mode])
}

/**
 * A mode's description naming the running engine ("Pi" or "OMP"). Takes the
 * caller's reactive `t` for the language-change reason above; the lookup
 * stays beside the key map so the i18n extractor can resolve it.
 */
export function getPermissionModeDescription(t: TFunction, mode: PermissionMode, agent: string): string {
  return t(PERMISSION_MODE_DESCRIPTION_KEYS[mode], { agent })
}
