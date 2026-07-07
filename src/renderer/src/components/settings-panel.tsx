import { useAppStore } from '../store'
import { useState, useEffect, useRef } from 'react'
import type { AppSettings, PermissionMode, CouncilConfig } from '../../../shared/ipc-contracts'
import { Settings, Save, RotateCcw, FolderOpen, Check } from 'lucide-react'
import { DEFAULT_SETTINGS } from '../../../shared/default-settings'
import { PermissionSelector } from './permission-selector'
import { applyTheme } from '../utils/theme'
import { CustomModelsEditor } from './custom-models-editor'
import {
  MIN_TIMEOUT_SECONDS as COUNCIL_MIN_TIMEOUT,
  MAX_TIMEOUT_SECONDS as COUNCIL_MAX_TIMEOUT,
  clampTimeoutSeconds as clampCouncilTimeout,
} from '../../../shared/council-config'

export function SettingsPanel(): React.JSX.Element {
  const settings = useAppStore((state) => state.settings)
  const loadSettings = useAppStore((state) => state.loadSettings)
  const setSettingsDraft = useAppStore((state) => state.setSettingsDraft)
  const clearSettingsDraft = useAppStore((state) => state.clearSettingsDraft)

  // Snapshot the unsaved draft once, for seeding initial local state. This is
  // what makes edits survive leaving/returning to Settings without saving.
  const draft0 = useAppStore.getState().settingsDraft

  const [piPath, setPiPath] = useState(draft0.piExecutablePath ?? settings?.piExecutablePath ?? DEFAULT_SETTINGS.piExecutablePath)
  const [theme, setTheme] = useState(draft0.theme ?? settings?.theme ?? DEFAULT_SETTINGS.theme)
  const [fontSize, setFontSize] = useState(draft0.fontSize ?? settings?.fontSize ?? DEFAULT_SETTINGS.fontSize)
  const [terminalFontSize, setTerminalFontSize] = useState(draft0.terminalFontSize ?? settings?.terminalFontSize ?? DEFAULT_SETTINGS.terminalFontSize)
  const [codeEditorFontSize, setCodeEditorFontSize] = useState(draft0.codeEditorFontSize ?? settings?.codeEditorFontSize ?? DEFAULT_SETTINGS.codeEditorFontSize)
  const [showThinking, setShowThinking] = useState(draft0.showThinking ?? settings?.showThinking ?? DEFAULT_SETTINGS.showThinking)
  const [autoScroll, setAutoScroll] = useState(draft0.autoScroll ?? settings?.autoScroll ?? DEFAULT_SETTINGS.autoScroll)
  const [resumeLastSession, setResumeLastSession] = useState(draft0.resumeLastSession ?? settings?.resumeLastSession ?? DEFAULT_SETTINGS.resumeLastSession)
  const [openToHomeOnLaunch, setOpenToHomeOnLaunch] = useState(draft0.openToHomeOnLaunch ?? settings?.openToHomeOnLaunch ?? DEFAULT_SETTINGS.openToHomeOnLaunch)
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    draft0.permissionMode ?? settings?.permissionMode ?? DEFAULT_SETTINGS.permissionMode,
  )
  const [saved, setSaved] = useState(false)

  const [showCouncilWarning, setShowCouncilWarning] = useState(false)
  const [detectedAgents, setDetectedAgents] = useState<Record<'pi' | 'claude' | 'codex', boolean>>({
    pi: false,
    claude: false,
    codex: false,
  })
  // Free-text draft for the timeout field so the user can clear it and type a
  // new value; it is clamped and persisted only on blur / Enter (not per keystroke).
  const [timeoutDraft, setTimeoutDraft] = useState('')

  // Detect available council agents on mount
  useEffect(() => {
    let cancelled = false
    void window.piDesktop.council.detect().then((result) => {
      if (cancelled) return
      const next: Record<'pi' | 'claude' | 'codex', boolean> = { pi: false, claude: false, codex: false }
      for (const agent of result.agents) {
        next[agent.id] = agent.found
      }
      setDetectedAgents(next)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Keep the timeout draft in sync with the persisted value (e.g. after a save
  // clamps it, or when settings first load).
  const councilTimeout = settings?.council?.timeoutSeconds
  useEffect(() => {
    if (councilTimeout !== undefined) setTimeoutDraft(String(councilTimeout))
  }, [councilTimeout])

  // Merge a council patch into the current config and persist via the store mechanism
  const saveCouncil = async (patch: Partial<CouncilConfig>): Promise<void> => {
    if (!settings) return
    const nextCouncil: CouncilConfig = { ...settings.council, ...patch }
    await window.piDesktop.settings.save({ council: nextCouncil })
    await loadSettings()
  }

  // Populate the form once, when settings first load. We deliberately do NOT
  // re-sync on every settings change: the UI font previews live and the
  // terminal/editor sizes are staged in store state, so re-syncing would
  // clobber other unsaved edits. Save/Reset set local state directly, so the
  // form stays correct without a re-sync.
  const didInitRef = useRef(false)
  useEffect(() => {
    if (!settings || didInitRef.current) return
    didInitRef.current = true
    const store = useAppStore.getState()
    const draft = store.settingsDraft
    setPiPath(draft.piExecutablePath ?? settings.piExecutablePath)
    setTheme(draft.theme ?? settings.theme)
    setFontSize(draft.fontSize ?? settings.fontSize)
    setTerminalFontSize(draft.terminalFontSize ?? settings.terminalFontSize)
    setCodeEditorFontSize(draft.codeEditorFontSize ?? settings.codeEditorFontSize)
    setShowThinking(draft.showThinking ?? settings.showThinking)
    setAutoScroll(draft.autoScroll ?? settings.autoScroll)
    setResumeLastSession(draft.resumeLastSession ?? settings.resumeLastSession)
    setOpenToHomeOnLaunch(draft.openToHomeOnLaunch ?? settings.openToHomeOnLaunch)
    setPermissionMode(draft.permissionMode ?? settings.permissionMode)
  }, [settings])

  const handleSelectPath = async () => {
    const path = await window.piDesktop.system.openDialog({ title: 'Select Pi Executable', mode: 'file' })
    if (path) {
      setPiPath(path)
      setSettingsDraft({ piExecutablePath: path })
    }
  }

  const handleSave = async () => {
    const updated: Partial<AppSettings> = {
      piExecutablePath: piPath,
      theme: theme as AppSettings['theme'],
      fontSize,
      terminalFontSize,
      codeEditorFontSize,
      showThinking,
      autoScroll,
      resumeLastSession,
      openToHomeOnLaunch,
      permissionMode,
    }

    const result = await window.piDesktop.settings.save(updated)

    // Apply theme and font size immediately
    applyTheme(result.theme)
    document.documentElement.style.fontSize = `${result.fontSize}px`

    // Reload settings in store
    await loadSettings()

    // Persisted now — drop the unsaved draft so the form and terminal/editor
    // read the saved settings (just refreshed).
    clearSettingsDraft()

    // Show saved indicator
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const handleReset = async () => {
    // Reset only the fields this panel exposes; the rest (council, default
    // model/provider/cwd, collapsed groups) are left as-is by the Partial merge.
    // Values come from the shared DEFAULT_SETTINGS so there's one source of truth.
    const defaults: Partial<AppSettings> = {
      piExecutablePath: DEFAULT_SETTINGS.piExecutablePath,
      theme: DEFAULT_SETTINGS.theme,
      fontSize: DEFAULT_SETTINGS.fontSize,
      terminalFontSize: DEFAULT_SETTINGS.terminalFontSize,
      codeEditorFontSize: DEFAULT_SETTINGS.codeEditorFontSize,
      showThinking: DEFAULT_SETTINGS.showThinking,
      autoScroll: DEFAULT_SETTINGS.autoScroll,
      resumeLastSession: DEFAULT_SETTINGS.resumeLastSession,
      openToHomeOnLaunch: DEFAULT_SETTINGS.openToHomeOnLaunch,
      permissionMode: DEFAULT_SETTINGS.permissionMode,
    }

    setPiPath(defaults.piExecutablePath!)
    setTheme(defaults.theme!)
    setFontSize(defaults.fontSize!)
    setTerminalFontSize(defaults.terminalFontSize!)
    setCodeEditorFontSize(defaults.codeEditorFontSize!)
    setShowThinking(defaults.showThinking!)
    setAutoScroll(defaults.autoScroll!)
    setResumeLastSession(defaults.resumeLastSession!)
    setOpenToHomeOnLaunch(defaults.openToHomeOnLaunch!)
    setPermissionMode(defaults.permissionMode!)

    const result = await window.piDesktop.settings.save(defaults)
    applyTheme(result.theme)
    document.documentElement.style.fontSize = `${result.fontSize}px`
    await loadSettings()
    clearSettingsDraft()

    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-8">
        {/* Header */}
        <div className="mb-8 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Settings size={20} className="text-neutral-400" />
            <h1 className="text-lg font-semibold text-neutral-200">Settings</h1>
          </div>
        </div>

        {/* Pi Configuration */}
        <SettingsSection title="Pi Configuration">
          <SettingsRow label="Pi Executable" description="Path to the Pi binary">
            <div className="flex gap-2">
              <input
                type="text"
                value={piPath}
                onChange={(e) => {
                  setPiPath(e.target.value)
                  setSettingsDraft({ piExecutablePath: e.target.value })
                }}
                className="flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 focus:border-blue-500 focus:outline-none"
              />
              <button
                onClick={handleSelectPath}
                className="rounded-md border border-neutral-700 px-3 py-1.5 text-sm text-neutral-400 hover:bg-neutral-800 transition-colors"
              >
                <FolderOpen size={14} />
              </button>
            </div>
          </SettingsRow>
        </SettingsSection>

        {/* Appearance */}
        <SettingsSection title="Appearance">
          <SettingsRow label="Theme" description="Application color scheme">
            <select
              value={theme}
              onChange={(e) => {
                const newTheme = e.target.value as AppSettings['theme']
                setTheme(newTheme)
                applyTheme(newTheme)
                setSettingsDraft({ theme: newTheme })
              }}
              className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 focus:border-blue-500 focus:outline-none"
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
              <option value="system">System</option>
              <option value="nord">Nord</option>
              <option value="gruvbox">Gruvbox</option>
              <option value="breeze-dark">Breeze Dark (Kate)</option>
              <option value="breeze-light">Breeze Light (Kate)</option>
              <option value="breeze-claudius">Breeze Claudius</option>
            </select>
          </SettingsRow>

          <SettingsRow label="UI Font Size" description="Chat, panels, and sidebar — not the terminal or code editor">
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={10}
                max={20}
                value={fontSize}
                onChange={(e) => {
                  const size = Number(e.target.value)
                  setFontSize(size)
                  document.documentElement.style.fontSize = `${size}px`
                  setSettingsDraft({ fontSize: size })
                }}
                className="flex-1 accent-blue-500"
              />
              <span className="w-8 text-right text-sm text-neutral-400">{fontSize}</span>
            </div>
          </SettingsRow>

          <SettingsRow label="Terminal Font Size" description="Font size for the terminal panel">
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={10}
                max={20}
                value={terminalFontSize}
                onChange={(e) => {
                  const size = Number(e.target.value)
                  setTerminalFontSize(size)
                  setSettingsDraft({ terminalFontSize: size })
                }}
                className="flex-1 accent-blue-500"
              />
              <span className="w-8 text-right text-sm text-neutral-400">{terminalFontSize}</span>
            </div>
          </SettingsRow>

          <SettingsRow label="Code Editor Font Size" description="Font size for the code editor / file viewer">
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={10}
                max={20}
                value={codeEditorFontSize}
                onChange={(e) => {
                  const size = Number(e.target.value)
                  setCodeEditorFontSize(size)
                  setSettingsDraft({ codeEditorFontSize: size })
                }}
                className="flex-1 accent-blue-500"
              />
              <span className="w-8 text-right text-sm text-neutral-400">{codeEditorFontSize}</span>
            </div>
          </SettingsRow>
        </SettingsSection>

        {/* Behavior */}
        <SettingsSection title="Behavior">
          <SettingsRow label="Permission Mode" description="Default safety mode for Pi actions">
            <PermissionSelector
              value={permissionMode}
              onChange={(mode) => {
                setPermissionMode(mode)
                setSettingsDraft({ permissionMode: mode })
              }}
              compact
            />
          </SettingsRow>

          <SettingsRow label="Show Thinking" description="Display model thinking blocks in responses">
            <Toggle checked={showThinking} onChange={(v) => { setShowThinking(v); setSettingsDraft({ showThinking: v }) }} />
          </SettingsRow>

          <SettingsRow label="Auto Scroll" description="Automatically scroll to new messages">
            <Toggle checked={autoScroll} onChange={(v) => { setAutoScroll(v); setSettingsDraft({ autoScroll: v }) }} />
          </SettingsRow>

          <SettingsRow
            label="Open to Home Screen on Launch"
            description="Show the Home launcher on startup; Pi starts only when you open a workspace or session"
          >
            <Toggle checked={openToHomeOnLaunch} onChange={(v) => { setOpenToHomeOnLaunch(v); setSettingsDraft({ openToHomeOnLaunch: v }) }} />
          </SettingsRow>

          <SettingsRow
            label="Resume Last Session"
            description="When opening a workspace, continue its most recent session instead of starting a new one"
          >
            <Toggle checked={resumeLastSession} onChange={(v) => { setResumeLastSession(v); setSettingsDraft({ resumeLastSession: v }) }} />
          </SettingsRow>
        </SettingsSection>

        {/* Multi-Agent Council Planning */}
        <SettingsSection title="Multi-Agent Council Planning">
          <SettingsRow
            label="Enable council planning"
            description="Spawns Claude/Codex alongside Pi to plan tasks. Increases token usage and credit/API costs."
          >
            <Toggle
              checked={settings?.council.enabled ?? false}
              onChange={(value) => {
                if (value) {
                  setShowCouncilWarning(true)
                } else {
                  void saveCouncil({ enabled: false })
                }
              }}
            />
          </SettingsRow>

          {settings?.council.enabled && (
            <>
              <SettingsRow label="Members" description="Which agents participate in council planning">
                <div className="flex flex-col gap-2">
                  {(['pi', 'claude', 'codex'] as const).map((id) => {
                    const detected = detectedAgents[id]
                    const label = id === 'pi' ? 'Pi' : id === 'claude' ? 'Claude' : 'Codex'
                    return (
                      <label
                        key={id}
                        className={`flex items-center gap-2 text-sm ${
                          detected ? 'text-neutral-200' : 'text-neutral-500'
                        }`}
                      >
                        <input
                          type="checkbox"
                          disabled={!detected}
                          checked={settings.council.members[id]}
                          onChange={(e) =>
                            void saveCouncil({
                              members: { ...settings.council.members, [id]: e.target.checked },
                            })
                          }
                          className="accent-blue-500 disabled:opacity-50"
                        />
                        <span>
                          {label}
                          {!detected && <span className="text-neutral-600"> (not detected)</span>}
                        </span>
                      </label>
                    )
                  })}
                </div>
              </SettingsRow>

              <SettingsRow
                label="Consensus mode"
                description="How council members reach agreement"
              >
                <select
                  value={settings.council.consensusMode}
                  onChange={(e) =>
                    void saveCouncil({
                      consensusMode: e.target.value as CouncilConfig['consensusMode'],
                    })
                  }
                  className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 focus:border-blue-500 focus:outline-none"
                >
                  <option value="arbiter">Arbiter merge (fast)</option>
                  <option value="debate">One debate round (slower, ~2x cost)</option>
                </select>
              </SettingsRow>

              <SettingsRow
                label="Per-member timeout (seconds)"
                description={`How long to wait for each agent (${COUNCIL_MIN_TIMEOUT}-${COUNCIL_MAX_TIMEOUT})`}
              >
                <input
                  type="number"
                  min={COUNCIL_MIN_TIMEOUT}
                  max={COUNCIL_MAX_TIMEOUT}
                  value={timeoutDraft}
                  onChange={(e) => setTimeoutDraft(e.target.value)}
                  onBlur={() => {
                    const clamped = clampCouncilTimeout(Number(timeoutDraft))
                    setTimeoutDraft(String(clamped))
                    if (clamped !== settings.council.timeoutSeconds) {
                      void saveCouncil({ timeoutSeconds: clamped })
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  }}
                  className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 focus:border-blue-500 focus:outline-none"
                />
              </SettingsRow>
            </>
          )}
        </SettingsSection>

        {/* Custom Models */}
        <SettingsSection title="Custom Models">
          <CustomModelsEditor />
        </SettingsSection>

        {/* Actions */}
        <div className="mt-8 flex gap-3">
          <button
            onClick={handleSave}
            className="flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-500 transition-colors"
          >
            {saved ? <Check size={14} /> : <Save size={14} />}
            {saved ? 'Saved!' : 'Save Settings'}
          </button>
          <button
            onClick={handleReset}
            className="flex items-center gap-2 rounded-md border border-neutral-700 px-4 py-2 text-sm text-neutral-400 hover:bg-neutral-800 transition-colors"
          >
            <RotateCcw size={14} />
            Reset to Defaults
          </button>
        </div>
      </div>

      {/* Council enable confirmation dialog */}
      {showCouncilWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-lg border border-neutral-700 bg-neutral-900 p-6 shadow-xl">
            <h3 className="mb-3 text-base font-semibold text-neutral-100">
              Enable council planning?
            </h3>
            <p className="mb-6 text-sm text-neutral-400">
              Each run spawns Claude and Codex in addition to Pi. This can significantly increase
              token usage and credit/API costs. Only enable this if you are comfortable with the
              extra spend.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowCouncilWarning(false)}
                className="rounded-md border border-neutral-700 px-4 py-2 text-sm text-neutral-400 hover:bg-neutral-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setShowCouncilWarning(false)
                  void saveCouncil({ enabled: true })
                }}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-500 transition-colors"
              >
                Enable
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Components ──────────────────────────────────────────────────────────────

function SettingsSection({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="mb-8">
      <h2 className="mb-4 text-sm font-medium text-neutral-300">{title}</h2>
      <div className="space-y-4 rounded-lg border border-neutral-800 bg-neutral-900/50 p-4">
        {children}
      </div>
    </div>
  )
}

function SettingsRow({
  label,
  description,
  children,
}: {
  label: string
  description: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <div className="text-sm text-neutral-200">{label}</div>
        <div className="text-xs text-neutral-500">{description}</div>
      </div>
      <div className="w-64">{children}</div>
    </div>
  )
}

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean
  onChange: (value: boolean) => void
}): React.JSX.Element {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
        checked ? 'bg-blue-600' : 'bg-neutral-700'
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
          checked ? 'translate-x-4' : 'translate-x-1'
        }`}
      />
    </button>
  )
}
