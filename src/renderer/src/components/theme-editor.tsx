import { useCallback, useEffect, useRef, useState } from 'react'
import { clsx } from 'clsx'
import { RotateCcw, X } from 'lucide-react'
import { useAppStore } from '../store'
import {
  MAX_THEME_NAME_LENGTH, SYNTAX_KEYS, type SyntaxKey, type ThemeFile,
} from '../../../shared/theme/theme-file'
import {
  SEED_NAMES, SEED_TO_TOKEN, TOKEN_NAMES, cssVarForToken,
  type SeedName, type TokenName,
} from '../../../shared/theme/tokens'
import { resolveThemeVars } from '../../../shared/theme/resolve'
import { applyThemeVars } from '../theme/engine'
import { applyTheme, registerThemes } from '../utils/theme'
import { forkTheme, withOverride, withSeed, withSyntax } from './theme-editor-helpers'

export { forkTheme, withOverride, withSeed, withSyntax }

export interface ThemeEditorProps {
  baseTheme: ThemeFile
  baseId: string
  isUserTheme: boolean
  onClose: () => void
  onSaved: (id: string) => void
}

const SEED_LABELS: Record<SeedName, string> = {
  app: 'App background',
  surface: 'Surface',
  text: 'Text',
  accent: 'Accent',
  success: 'Success',
  warning: 'Warning',
  error: 'Error',
}

// The 7 seed tokens (app/surface/primary/accent/success/warning/error) are
// edited via the seed rows, not the Advanced list — listing them twice would
// let the two controls fight over the same value.
const SEED_BACKED_TOKENS = new Set<TokenName>(Object.values(SEED_TO_TOKEN))
const ADVANCED_TOKENS = TOKEN_NAMES.filter((token) => !SEED_BACKED_TOKENS.has(token))

const HEX6_PATTERN = /^#[0-9a-fA-F]{6}$/
const HEX3_PATTERN = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/
const FALLBACK_SWATCH_COLOR = '#000000'
const HEX_TEXT_INPUT_MAX_LENGTH = 9 // '#RRGGBBAA'

// <input type="color"> only accepts 6-digit hex. Seed values and pinned
// overrides may be entered as 3-digit hex, rgba(), or left unset (derived,
// e.g. an unresolved `color-mix(...)` expression) — none of which the color
// picker can parse. The text field next to it always carries the true value;
// this only feeds the swatch a best-effort approximation.
function normalizeHexColor(value: string | undefined | null): string {
  if (!value) return FALLBACK_SWATCH_COLOR
  const trimmed = value.trim()
  if (HEX6_PATTERN.test(trimmed)) return trimmed
  const short = HEX3_PATTERN.exec(trimmed)
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`
  return FALLBACK_SWATCH_COLOR
}

function tokenLabel(name: string): string {
  return name.replace(/-/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())
}

export function ThemeEditor({
  baseTheme, baseId, isUserTheme, onClose, onSaved,
}: ThemeEditorProps): React.JSX.Element {
  const settingsThemeId = useAppStore((s) => s.settingsDraft.theme ?? s.settings?.theme ?? 'dark')
  const setSettingsDraft = useAppStore((s) => s.setSettingsDraft)

  const [draft, setDraft] = useState<ThemeFile>(() =>
    isUserTheme ? structuredClone(baseTheme) : forkTheme(baseTheme, `${baseTheme.name} Copy`))
  const previousKeys = useRef<string[]>([])
  const [effective, setEffective] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const preview = useCallback((next: ThemeFile) => {
    setDraft(next)
    previousKeys.current = applyThemeVars(
      document.documentElement, resolveThemeVars(next), previousKeys.current)
    const style = getComputedStyle(document.documentElement)
    const read: Record<string, string> = {}
    for (const token of TOKEN_NAMES) read[token] = style.getPropertyValue(cssVarForToken(token)).trim()
    for (const key of SYNTAX_KEYS) read[`cm:${key}`] = style.getPropertyValue(`--cm-${key}`).trim()
    setEffective(read)
  }, [])

  useEffect(() => {
    preview(draft)
    // Apply the initial draft once on mount; every subsequent change flows
    // back through `preview` from the row handlers below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const cancel = useCallback(() => {
    applyTheme(settingsThemeId)
    onClose()
  }, [settingsThemeId, onClose])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        cancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cancel])

  const save = async () => {
    if (draft.name.trim().length === 0) return
    setSaving(true)
    setSaveError(null)
    try {
      const { id } = await window.piDesktop.themes.save(draft)
      if (isUserTheme && id !== baseId) await window.piDesktop.themes.delete(baseId)
      registerThemes([{ id, file: draft }])
      applyTheme(id)
      setSettingsDraft({ theme: id })
      onSaved(id)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const nameEmpty = draft.name.trim().length === 0

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) cancel()
      }}
    >
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-lg border border-border-strong bg-surface shadow-xl">
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <h2 className="text-base font-semibold text-primary">
            {isUserTheme ? 'Edit theme' : 'Create theme'}
          </h2>
          <button
            type="button"
            onClick={cancel}
            className="rounded-md p-1 text-dim hover:bg-surface-hover transition-colors"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto px-6 py-4">
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <label className="mb-1 block text-xs text-dim" htmlFor="theme-editor-name">
                Name
              </label>
              <input
                id="theme-editor-name"
                type="text"
                value={draft.name}
                maxLength={MAX_THEME_NAME_LENGTH}
                onChange={(event) => preview({ ...draft, name: event.target.value })}
                className="w-full rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm text-primary focus:border-focus focus:outline-none"
              />
            </div>
            <div>
              <span className="mb-1 block text-xs text-dim">Kind</span>
              <div className="flex overflow-hidden rounded-md border border-border-strong">
                {(['dark', 'light'] as const).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => preview({ ...draft, kind })}
                    className={clsx(
                      'px-3 py-1.5 text-sm capitalize transition-colors',
                      draft.kind === kind
                        ? 'bg-accent text-white'
                        : 'text-muted hover:bg-surface-hover'
                    )}
                  >
                    {kind}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="space-y-2">
            {SEED_NAMES.map((seed) => (
              <div key={seed} className="flex items-center justify-between gap-3">
                <label className="text-sm text-primary" htmlFor={`theme-editor-seed-${seed}`}>
                  {SEED_LABELS[seed]}
                </label>
                <div className="flex items-center gap-2">
                  <input
                    id={`theme-editor-seed-${seed}`}
                    type="color"
                    value={normalizeHexColor(draft.seeds[seed])}
                    onChange={(event) => preview(withSeed(draft, seed, event.target.value))}
                    className="h-8 w-10 cursor-pointer rounded border border-border-strong bg-surface p-0.5"
                  />
                  <input
                    type="text"
                    value={draft.seeds[seed]}
                    onChange={(event) => preview(withSeed(draft, seed, event.target.value))}
                    maxLength={HEX_TEXT_INPUT_MAX_LENGTH}
                    className="w-28 rounded-md border border-border-strong bg-surface px-2 py-1 text-xs font-mono text-primary focus:border-focus focus:outline-none"
                  />
                </div>
              </div>
            ))}
          </div>

          <details className="rounded-md border border-border">
            <summary className="cursor-pointer select-none px-3 py-2 text-sm text-secondary">
              Advanced
            </summary>
            <div className="space-y-1 border-t border-border px-3 py-2">
              {ADVANCED_TOKENS.map((token) => {
                const overrideValue = draft.overrides?.[token]
                return (
                  <TokenPinRow
                    key={token}
                    label={tokenLabel(token)}
                    effectiveValue={effective[token] ?? ''}
                    overrideValue={overrideValue}
                    onPin={(value) => preview(withOverride(draft, token, value))}
                    onReset={() => preview(withOverride(draft, token, null))}
                  />
                )
              })}
            </div>
          </details>

          <details className="rounded-md border border-border">
            <summary className="cursor-pointer select-none px-3 py-2 text-sm text-secondary">
              Syntax colors
            </summary>
            <div className="space-y-1 border-t border-border px-3 py-2">
              {SYNTAX_KEYS.map((key: SyntaxKey) => {
                const overrideValue = draft.syntax?.[key]
                return (
                  <TokenPinRow
                    key={key}
                    label={tokenLabel(key)}
                    effectiveValue={effective[`cm:${key}`] ?? ''}
                    overrideValue={overrideValue}
                    onPin={(value) => preview(withSyntax(draft, key, value))}
                    onReset={() => preview(withSyntax(draft, key, null))}
                  />
                )
              })}
            </div>
          </details>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border px-6 py-4">
          <p className="text-xs text-error">{saveError}</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={cancel}
              className="rounded-md border border-border-strong px-4 py-2 text-sm text-muted hover:bg-surface-hover transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={nameEmpty || saving}
              className="rounded-md bg-accent px-4 py-2 text-sm text-white hover:bg-accent-hover transition-colors disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function TokenPinRow({
  label, effectiveValue, overrideValue, onPin, onReset,
}: {
  label: string
  effectiveValue: string
  overrideValue: string | undefined
  onPin: (value: string) => void
  onReset: () => void
}): React.JSX.Element {
  const pinned = overrideValue !== undefined
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <span className="text-sm text-secondary">{label}</span>
      <div className="flex items-center gap-2">
        <span
          className="w-40 truncate text-right font-mono text-xs text-dim"
          title={effectiveValue}
        >
          {effectiveValue}
        </span>
        <input
          type="color"
          value={normalizeHexColor(overrideValue ?? effectiveValue)}
          onChange={(event) => onPin(event.target.value)}
          className="h-7 w-9 cursor-pointer rounded border border-border-strong bg-surface p-0.5"
        />
        <button
          type="button"
          onClick={onReset}
          disabled={!pinned}
          title="Reset to derived value"
          className="rounded-md border border-border-strong p-1 text-dim hover:bg-surface-hover transition-colors disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <RotateCcw size={12} />
        </button>
      </div>
    </div>
  )
}
