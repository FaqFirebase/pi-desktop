import { useAppStore } from '../store'
import type { CatalogPackage } from '../../../shared/ipc-contracts'
import { filterCatalog } from '../../../shared/package-filter'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { clsx } from 'clsx'
import {
  Package,
  Search,
  Download,
  Trash2,
  ExternalLink,
  Loader2,
  Store,
  FolderOpen,
  Puzzle,
  CheckCircle2,
  AlertCircle,
  X,
} from 'lucide-react'

export function PackageBrowser(): React.JSX.Element {
  const installedPackages = useAppStore((state) => state.installedPackages)
  const catalogPackages = useAppStore((state) => state.catalogPackages)
  const packageLoading = useAppStore((state) => state.packageLoading)
  const catalogLoading = useAppStore((state) => state.catalogLoading)
  const packageNotification = useAppStore((state) => state.packageNotification)
  const loadInstalledPackages = useAppStore((state) => state.loadInstalledPackages)
  const installPackage = useAppStore((state) => state.installPackage)
  const removePackage = useAppStore((state) => state.removePackage)
  const loadCatalog = useAppStore((state) => state.loadCatalog)
  const clearPackageNotification = useAppStore((state) => state.clearPackageNotification)
  const installedSkills = useAppStore((state) => state.installedSkills)
  const loadSkills = useAppStore((state) => state.loadSkills)

  // Memoized so the tab components (below, React.memo'd) don't re-render just
  // because this Set was rebuilt on an unrelated render.
  const installedNames = useMemo(
    () => new Set(installedPackages.map((p) => p.name)),
    [installedPackages]
  )

  const [activeTab, setActiveTab] = useState<'installed' | 'catalog' | 'skills'>('installed')

  // Installed packages and skills are local/fast — load them up front so the
  // default Installed tab paints immediately.
  useEffect(() => {
    loadInstalledPackages()
    loadSkills()
  }, [loadInstalledPackages, loadSkills])

  // The catalog requires a (prefetched) network crawl — load it lazily the first
  // time the Catalog tab is opened, so opening Packages never blocks on it.
  const catalogRequested = useRef(false)
  useEffect(() => {
    if (activeTab === 'catalog' && !catalogRequested.current) {
      catalogRequested.current = true
      loadCatalog()
    }
  }, [activeTab, loadCatalog])

  const handleRemove = useCallback((spec: string) => { removePackage(spec) }, [removePackage])

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Header */}
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center gap-2 mb-3">
          <Package size={16} className="text-muted" />
          <h2 className="text-sm font-medium text-primary">Packages & Skills</h2>
        </div>

        {/* Tabs */}
        <div className="flex gap-1">
          <TabButton
            active={activeTab === 'installed'}
            onClick={() => setActiveTab('installed')}
            icon={<FolderOpen size={12} />}
            label="Installed"
            count={installedPackages.length}
          />
          <TabButton
            active={activeTab === 'catalog'}
            onClick={() => setActiveTab('catalog')}
            icon={<Store size={12} />}
            label="Catalog"
          />
          <TabButton
            active={activeTab === 'skills'}
            onClick={() => setActiveTab('skills')}
            icon={<Puzzle size={12} />}
            label="Skills"
            count={installedSkills.length}
          />
        </div>
      </div>

      {/* Install bar (isolated: its keystrokes never re-render the tab lists) */}
      <InstallBar />

      {/* Notification banner */}
      {packageNotification && (
        <div className={clsx(
          'flex items-start gap-2 px-4 py-2.5 text-sm border-b',
          packageNotification.type === 'success'
            ? 'bg-success-bg border-success-bg text-success'
            : 'bg-error-bg border-error-bg text-error'
        )}>
          {packageNotification.type === 'success'
            ? <CheckCircle2 size={15} className="mt-0.5 shrink-0" />
            : <AlertCircle size={15} className="mt-0.5 shrink-0" />
          }
          <span className="flex-1 text-xs leading-relaxed">{packageNotification.message}</span>
          <button
            type="button"
            onClick={clearPackageNotification}
            className="shrink-0 rounded p-0.5 opacity-60 hover:opacity-100 transition-opacity"
            aria-label="Dismiss"
          >
            <X size={13} />
          </button>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {activeTab === 'installed' && (
          <InstalledTab
            packages={installedPackages}
            loading={packageLoading}
            onRemove={handleRemove}
          />
        )}
        {activeTab === 'catalog' && (
          <CatalogTab
            packages={catalogPackages}
            loading={catalogLoading}
            onInstall={installPackage}
            installedNames={installedNames}
          />
        )}
        {activeTab === 'skills' && (
          <SkillsTab skills={installedSkills} />
        )}
      </div>
    </div>
  )
}

// ─── Install Bar ─────────────────────────────────────────────────────────────

// Isolated so typing a package spec only re-renders this small component — it
// never touches the Installed/Catalog/Skills lists. Install runs only on click.
function InstallBar(): React.JSX.Element {
  const installPackage = useAppStore((state) => state.installPackage)
  const [installInput, setInstallInput] = useState('')
  const [installing, setInstalling] = useState(false)

  const handleInstall = async (): Promise<void> => {
    const spec = installInput.trim()
    if (!spec) return
    setInstalling(true)
    await installPackage(spec)
    setInstallInput('')
    setInstalling(false)
  }

  return (
    <div className="border-b border-border px-4 py-3">
      <div className="flex gap-2">
        <input
          type="text"
          value={installInput}
          onChange={(e) => setInstallInput(e.target.value)}
          placeholder="npm:package-name or git:github.com/user/repo"
          className="flex-1 rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm text-primary placeholder:text-faint focus:border-focus focus:outline-none"
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleInstall()
          }}
        />
        <button
          type="button"
          onClick={handleInstall}
          disabled={installing || !installInput.trim()}
          className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm text-white hover:bg-accent-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {installing ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          Install
        </button>
      </div>
    </div>
  )
}

// ─── Tab Buttons ─────────────────────────────────────────────────────────────

function TabButton({
  active,
  onClick,
  icon,
  label,
  count,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
  count?: number
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition-colors',
        active
          ? 'bg-card text-primary'
          : 'text-dim hover:bg-surface-hover/50 hover:text-secondary'
      )}
    >
      {icon}
      {label}
      {count !== undefined && count > 0 && (
        <span className="rounded-full bg-elevated px-1.5 py-0.5 text-[10px]">{count}</span>
      )}
    </button>
  )
}

// ─── Installed Tab ───────────────────────────────────────────────────────────

const InstalledTab = memo(function InstalledTab({
  packages,
  loading,
  onRemove,
}: {
  packages: Array<{ name: string; source: string; type: string; version: string | null }>
  loading: boolean
  onRemove: (spec: string) => void
}): React.JSX.Element {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 size={24} className="animate-spin text-dim" />
      </div>
    )
  }

  if (packages.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-dim">
        <Package size={32} className="mb-3 text-faint" />
        <p className="text-sm">No packages installed</p>
        <p className="mt-1 text-xs text-faint">Browse the catalog or use the install bar above</p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {packages.map((pkg) => (
        <div
          key={pkg.source}
          className="flex items-center justify-between rounded-lg border border-border bg-surface/50 px-4 py-3"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-primary">{pkg.name}</span>
              {pkg.version && (
                <span className="rounded bg-card px-1.5 py-0.5 text-[10px] text-dim">
                  v{pkg.version}
                </span>
              )}
              <span className="rounded bg-accent-bg px-1.5 py-0.5 text-[10px] text-accent-fg">
                {pkg.type}
              </span>
            </div>
            <div className="mt-0.5 text-xs text-dim truncate">{pkg.source}</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => window.piDesktop.system.openExternal(`https://www.npmjs.com/package/${pkg.name}`)}
              className="rounded p-1.5 text-dim hover:bg-surface-hover hover:text-secondary transition-colors"
              title="View on npm"
            >
              <ExternalLink size={14} />
            </button>
            <button
              type="button"
              onClick={() => onRemove(pkg.source)}
              className="rounded p-1.5 text-dim hover:bg-error-bg hover:text-error transition-colors"
              title="Remove package"
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      ))}
    </div>
  )
})

// ─── Catalog Tab ─────────────────────────────────────────────────────────────

// Cap on rendered rows: the full catalog can be ~thousands of packages, so we
// render a slice and prompt the user to refine rather than paint them all.
const CATALOG_RENDER_CAP = 100

const CatalogTab = memo(function CatalogTab({
  packages,
  loading,
  onInstall,
  installedNames,
}: {
  packages: CatalogPackage[]
  loading: boolean
  onInstall: (spec: string) => void
  installedNames: Set<string>
}): React.JSX.Element {
  // Search is local state and filtering runs in-renderer against the already
  // loaded catalog — no per-keystroke IPC or loading toggle.
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => filterCatalog(packages, query), [packages, query])
  const shown = filtered.slice(0, CATALOG_RENDER_CAP)

  return (
    <div>
      {/* Search */}
      <div className="mb-4">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-dim" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search packages..."
            className="w-full rounded-lg border border-border-strong bg-surface py-2 pl-9 pr-4 text-sm text-primary placeholder:text-faint focus:border-focus focus:outline-none"
          />
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={24} className="animate-spin text-dim" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-dim">
          <Store size={32} className="mb-3 text-faint" />
          <p className="text-sm">No packages found</p>
          <p className="mt-1 text-xs text-faint">
            Visit{' '}
            <button
              type="button"
              onClick={() => window.piDesktop.system.openExternal('https://pi.dev/packages')}
              className="text-accent-fg hover:underline"
            >
              pi.dev/packages
            </button>{' '}
            to browse
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {shown.map((pkg, index) => (
            <div
              key={`${pkg.name}-${index}`}
              className="rounded-lg border border-border bg-surface/50 px-4 py-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-primary">{pkg.name}</span>
                    <span className={clsx(
                      'rounded px-1.5 py-0.5 text-[10px]',
                      pkg.type === 'extension'
                        ? 'bg-success-bg text-success'
                        : 'bg-accent-bg text-accent-fg'
                    )}>
                      {pkg.type}
                    </span>
                  </div>
                  {pkg.description && (
                    <p className="mt-1 text-xs text-muted line-clamp-2">{pkg.description}</p>
                  )}
                  <div className="mt-1.5 flex items-center gap-3 text-[11px] text-faint">
                    {pkg.author && <span>{pkg.author}</span>}
                    {pkg.downloadsDisplay && <span>{pkg.downloadsDisplay}</span>}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
                  {pkg.npmUrl && (
                    <button
                      type="button"
                      onClick={() => window.piDesktop.system.openExternal(pkg.npmUrl!)}
                      className="rounded p-1.5 text-dim hover:bg-surface-hover hover:text-secondary transition-colors"
                      title="View on npm"
                    >
                      <ExternalLink size={13} />
                    </button>
                  )}
                  {pkg.repoUrl && (
                    <button
                      type="button"
                      onClick={() => window.piDesktop.system.openExternal(pkg.repoUrl!)}
                      className="rounded p-1.5 text-dim hover:bg-surface-hover hover:text-secondary transition-colors"
                      title="View repo"
                    >
                      <ExternalLink size={13} />
                    </button>
                  )}
                  {installedNames.has(pkg.name) ? (
                    <span className="flex items-center gap-1 rounded bg-success-bg px-2.5 py-1 text-xs text-success">
                      <CheckCircle2 size={12} />
                      Installed
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onInstall(pkg.installCommand)}
                      className="flex items-center gap-1 rounded bg-accent px-2.5 py-1 text-xs text-white hover:bg-accent-hover transition-colors"
                    >
                      <Download size={12} />
                      Install
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
          {filtered.length > shown.length && (
            <div className="py-3 text-center text-xs text-faint">
              Showing {shown.length} of {filtered.length} — refine your search to narrow results.
            </div>
          )}
        </div>
      )}
    </div>
  )
})

// ─── Skills Tab ──────────────────────────────────────────────────────────────

const SkillsTab = memo(function SkillsTab({
  skills,
}: {
  skills: Array<{ name: string; description: string; path: string; source: string; enabled: boolean }>
}): React.JSX.Element {
  if (skills.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-dim">
        <Puzzle size={32} className="mb-3 text-faint" />
        <p className="text-sm">No skills found</p>
        <p className="mt-1 text-xs text-faint">
          Install skill packages or create skills in .pi/skills/
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {skills.map((skill) => (
        <div
          key={skill.path}
          className="rounded-lg border border-border bg-surface/50 px-4 py-3"
        >
          <div className="flex items-center gap-2">
            <Puzzle size={14} className="text-special" />
            <span className="text-sm font-medium text-primary">{skill.name}</span>
            <span className={clsx(
              'rounded px-1.5 py-0.5 text-[10px]',
              skill.source === 'global' ? 'bg-accent-bg text-accent-fg' : 'bg-success-bg text-success'
            )}>
              {skill.source}
            </span>
          </div>
          <p className="mt-1 text-xs text-dim">{skill.description}</p>
          <div className="mt-2 flex items-center gap-2 text-xs text-faint">
            <span className="truncate">{skill.path}</span>
          </div>
        </div>
      ))}
    </div>
  )
})
