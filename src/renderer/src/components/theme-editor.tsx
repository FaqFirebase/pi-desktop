import { useCallback, useEffect, useRef, useState } from 'react'
import { clsx } from 'clsx'
import { RotateCcw, X } from 'lucide-react'
import { useAppStore } from '../store'
import {
  MAX_THEME_NAME_LENGTH, MAX_THEME_AUTHOR_LENGTH, MAX_THEME_DESCRIPTION_LENGTH,
  SYNTAX_KEYS, type SyntaxKey, type ThemeFile,
} from '../../../shared/theme/theme-file'
import {
  SEED_NAMES, SEED_TO_TOKEN, TOKEN_NAMES, cssVarForToken,
  type SeedName, type TokenName,
} from '../../../shared/theme/tokens'
import { resolveThemeVars } from '../../../shared/theme/resolve'
import { applyThemeVars } from '../theme/engine'
import { applyTheme, registerThemes, setThemePreviewActive } from '../utils/theme'
import { forkTheme, withOverride, withSeed, withSyntax } from './theme-editor-helpers'

export { forkTheme, withOverride, withSeed, withSyntax }

export interface ThemeEditorProps {
  baseTheme: ThemeFile
  baseId: string
  isUserTheme: boolean
  onClose: () => void
  // `warning` carries a non-fatal post-save problem (e.g. rename cleanup
  // failure). It must be surfaced by the parent, not via this editor's own
  // saveError state: onSaved unmounts the editor in the same React commit,
  // so a message set here would never paint.
  onSaved: (id: string, warning?: string) => void
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

// Shared by the render-time selector and the unmount-cleanup effect below —
// both need "what theme is currently persisted/drafted", but the cleanup
// reads it via `useAppStore.getState()` at cleanup time rather than through
// the hook, so the two call sites can't share a `useAppStore(...)` call.
function resolveSettingsThemeId(state: ReturnType<typeof useAppStore.getState>): string {
  return state.settingsDraft.theme ?? state.settings?.theme ?? 'dark'
}

export function ThemeEditor({
  baseTheme, baseId, isUserTheme, onClose, onSaved,
}: ThemeEditorProps): React.JSX.Element {
  const settingsThemeId = useAppStore(resolveSettingsThemeId)
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
    // Mirror applyTheme's non-variable side effects so a kind toggle takes
    // full effect during preview, not just on save: the `light` class is the
    // documented kind signal on <html> (a hook for user CSS), and colorScheme
    // flips native browser chrome — including the color-picker inputs this
    // editor itself renders — immediately rather than only after save/cancel.
    document.documentElement.classList.toggle('light', next.kind === 'light')
    document.documentElement.style.colorScheme = next.kind
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

  useEffect(() => {
    // This editor mutates document-level CSS vars/class/colorScheme for live
    // preview. `ThemeEditor` lives inside `SettingsPanel`, which unmounts
    // outright (no `hidden`-class preservation) whenever the user navigates
    // to another sidebar view — a path that goes through neither `cancel()`
    // nor a successful `save()`. Without this cleanup, an abandoned draft's
    // preview would stay applied to the whole app indefinitely. It reads the
    // settings theme fresh from the store (not the `settingsThemeId` value
    // closed over at mount) because a successful save updates the store's
    // settingsDraft before this component unmounts — using the mount-time
    // value here would clobber that just-saved theme with the stale one.
    // Claim the live-preview lock so an OS light/dark change (watchSystemTheme)
    // can't overwrite this editor's unsaved preview vars while it is open.
    setThemePreviewActive(true)
    return () => {
      setThemePreviewActive(false)
      applyTheme(resolveSettingsThemeId(useAppStore.getState()))
    }
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
      // The validator treats empty metadata strings as errors ("omit instead"),
      // and a user who typed then cleared a field leaves '' in the draft — so
      // strip blank author/description before the payload crosses IPC. Trim the
      // kept values too, so the in-session registry copy below matches the
      // trimmed form the main-process validator persists to disk.
      const { author, description, ...rest } = draft
      const trimmedAuthor = author?.trim()
      const trimmedDescription = description?.trim()
      const payload: ThemeFile = {
        ...rest,
        ...(trimmedAuthor ? { author: trimmedAuthor } : {}),
        ...(trimmedDescription ? { description: trimmedDescription } : {}),
      }
      // Pass baseId as existingId only when editing an already-saved user
      // theme: it scopes the possible overwrite to that exact file, so a
      // rename that happens to collide with another user theme's name gets
      // suffixed instead of silently overwriting that other theme's file.
      // Forking a built-in or creating fresh has no existing file to protect.
      const { id } = await window.piDesktop.themes.save(payload, isUserTheme ? baseId : undefined)
      // The theme file write has already succeeded at this point, so commit
      // it to app state unconditionally before attempting the rename cleanup
      // below. If the old-id delete throws, the catch below must not run
      // first — that would leave a real, saved theme file on disk that the
      // registry, applied theme, and settings draft have no record of.
      registerThemes([{ id, file: payload }])
      applyTheme(id)
      setSettingsDraft({ theme: id })
      let warning: string | undefined
      if (isUserTheme && id !== baseId) {
        try {
          await window.piDesktop.themes.delete(baseId)
        } catch {
          // Save succeeded and is already fully applied above; only the
          // old file's cleanup failed. Still proceed as a successful save
          // (the leftover old-id registry entry until restart is a known,
          // accepted limitation — see task report), passing the warning
          // through onSaved for the parent to render.
          warning =
            `Theme saved as "${draft.name}", but the old version could not be removed and may still appear in the list.`
        }
      }
      onSaved(id, warning)
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

          <div className="flex items-start gap-4">
            <div className="w-56">
              <label className="mb-1 block text-xs text-dim" htmlFor="theme-editor-author">
                Author (optional)
              </label>
              <input
                id="theme-editor-author"
                type="text"
                value={draft.author ?? ''}
                maxLength={MAX_THEME_AUTHOR_LENGTH}
                placeholder="Shown in the gallery"
                onChange={(event) => preview({ ...draft, author: event.target.value })}
                className="w-full rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm text-primary focus:border-focus focus:outline-none"
              />
            </div>
            <div className="flex-1">
              <label className="mb-1 block text-xs text-dim" htmlFor="theme-editor-description">
                Description (optional)
              </label>
              <input
                id="theme-editor-description"
                type="text"
                value={draft.description ?? ''}
                maxLength={MAX_THEME_DESCRIPTION_LENGTH}
                placeholder="One or two sentences about the theme"
                onChange={(event) => preview({ ...draft, description: event.target.value })}
                className="w-full rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm text-primary focus:border-focus focus:outline-none"
              />
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
