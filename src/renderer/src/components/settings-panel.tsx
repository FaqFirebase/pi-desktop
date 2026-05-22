import { useAppStore } from '../store'
import { useState, useEffect } from 'react'
import type { AppSettings, PermissionMode } from '../../../shared/ipc-contracts'
import { Settings, Save, RotateCcw, FolderOpen, Check } from 'lucide-react'
import { DEFAULT_PERMISSION_MODE } from './permission-mode'
import { PermissionSelector } from './permission-selector'

export function SettingsPanel(): React.JSX.Element {
  const settings = useAppStore((state) => state.settings)
  const setCurrentView = useAppStore((state) => state.setCurrentView)
  const loadSettings = useAppStore((state) => state.loadSettings)

  const [piPath, setPiPath] = useState(settings?.piExecutablePath ?? 'pi')
  const [theme, setTheme] = useState(settings?.theme ?? 'dark')
  const [fontSize, setFontSize] = useState(settings?.fontSize ?? 14)
  const [showThinking, setShowThinking] = useState(settings?.showThinking ?? true)
  const [autoScroll, setAutoScroll] = useState(settings?.autoScroll ?? true)
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    settings?.permissionMode ?? DEFAULT_PERMISSION_MODE,
  )
  const [saved, setSaved] = useState(false)

  // Sync from store when settings load
  useEffect(() => {
    if (settings) {
      setPiPath(settings.piExecutablePath)
      setTheme(settings.theme)
      setFontSize(settings.fontSize)
      setShowThinking(settings.showThinking)
      setAutoScroll(settings.autoScroll)
      setPermissionMode(settings.permissionMode)
    }
  }, [settings])

  const handleSelectPath = async () => {
    const path = await window.piDesktop.system.openDialog({ title: 'Select PI Executable' })
    if (path) setPiPath(path)
  }

  const handleSave = async () => {
    const updated: Partial<AppSettings> = {
      piExecutablePath: piPath,
      theme: theme as AppSettings['theme'],
      fontSize,
      showThinking,
      autoScroll,
      permissionMode,
    }

    const result = await window.piDesktop.settings.save(updated)

    // Apply theme and font size immediately
    applyTheme(result.theme)
    document.documentElement.style.fontSize = `${result.fontSize}px`

    // Reload settings in store
    await loadSettings()

    // Show saved indicator
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const handleReset = async () => {
    const defaults: Partial<AppSettings> = {
      piExecutablePath: 'pi',
      theme: 'dark',
      fontSize: 14,
      showThinking: true,
      autoScroll: true,
      permissionMode: DEFAULT_PERMISSION_MODE,
    }

    setPiPath(defaults.piExecutablePath!)
    setTheme(defaults.theme!)
    setFontSize(defaults.fontSize!)
    setShowThinking(defaults.showThinking!)
    setAutoScroll(defaults.autoScroll!)
    setPermissionMode(defaults.permissionMode!)

    const result = await window.piDesktop.settings.save(defaults)
    applyTheme(result.theme)
    await loadSettings()

    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-2xl px-6 py-8">
        {/* Header */}
        <div className="mb-8 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Settings size={20} className="text-neutral-400" />
            <h1 className="text-lg font-semibold text-neutral-200">Settings</h1>
          </div>
          <button
            onClick={() => setCurrentView('chat')}
            className="rounded-md px-3 py-1.5 text-sm text-neutral-400 hover:text-neutral-200 transition-colors"
          >
            Back to Chat
          </button>
        </div>

        {/* PI Configuration */}
        <SettingsSection title="PI Configuration">
          <SettingsRow label="PI Executable" description="Path to the PI binary">
            <div className="flex gap-2">
              <input
                type="text"
                value={piPath}
                onChange={(e) => setPiPath(e.target.value)}
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
              }}
              className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 focus:border-blue-500 focus:outline-none"
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
              <option value="system">System</option>
              <option value="nord">Nord</option>
              <option value="gruvbox">Gruvbox</option>
            </select>
          </SettingsRow>

          <SettingsRow label="Font Size" description="Base font size in pixels">
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
                }}
                className="flex-1 accent-blue-500"
              />
              <span className="w-8 text-right text-sm text-neutral-400">{fontSize}</span>
            </div>
          </SettingsRow>
        </SettingsSection>

        {/* Behavior */}
        <SettingsSection title="Behavior">
          <SettingsRow label="Permission Mode" description="Default safety mode for PI actions">
            <PermissionSelector
              value={permissionMode}
              onChange={(mode) => setPermissionMode(mode)}
              compact
            />
          </SettingsRow>

          <SettingsRow label="Show Thinking" description="Display model thinking blocks in responses">
            <Toggle checked={showThinking} onChange={setShowThinking} />
          </SettingsRow>

          <SettingsRow label="Auto Scroll" description="Automatically scroll to new messages">
            <Toggle checked={autoScroll} onChange={setAutoScroll} />
          </SettingsRow>
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
    </div>
  )
}

// ─── Theme Application ───────────────────────────────────────────────────────

const THEME_CLASSES = ['dark', 'light', 'nord', 'gruvbox'] as const

function applyTheme(theme: string): void {
  const html = document.documentElement
  html.classList.remove(...THEME_CLASSES)

  if (theme === 'light') {
    html.classList.add('light')
    html.style.colorScheme = 'light'
  } else if (theme === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    html.classList.add(prefersDark ? 'dark' : 'light')
    html.style.colorScheme = prefersDark ? 'dark' : 'light'
  } else {
    // 'dark' | 'nord' | 'gruvbox' — all dark-based
    html.classList.add(theme)
    html.style.colorScheme = 'dark'
  }
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
