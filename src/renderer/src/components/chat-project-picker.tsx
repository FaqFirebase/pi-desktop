import { useEffect, useMemo, useRef, useState } from 'react'
import { clsx } from 'clsx'
import { Check, ChevronDown, FolderOpen, Layers } from 'lucide-react'
import { useAppStore } from '../store'
import type { Workspace } from '../../../shared/ipc-contracts'
import { pathsEqual } from '../../../shared/path-compare'

/**
 * Compact project picker for the empty-chat center prompt.
 * Defaults to the active workspace; supports No project → home directory.
 */
export function ChatProjectPicker(): React.JSX.Element {
  const workspaces = useAppStore((s) => s.workspaces)
  const activeWorkspace = useAppStore((s) => s.activeWorkspace)
  const switchWorkspace = useAppStore((s) => s.switchWorkspace)
  const createWorkspace = useAppStore((s) => s.createWorkspace)
  const startPi = useAppStore((s) => s.startPi)

  const sorted = useMemo(
    () => [...workspaces].sort((a, b) => b.lastActiveAt - a.lastActiveAt),
    [workspaces]
  )

  // null = no project (home dir); string = workspace id
  const [selectedId, setSelectedId] = useState<string | null>(
    () => activeWorkspace?.id ?? sorted[0]?.id ?? null
  )
  const [pickerOpen, setPickerOpen] = useState(false)
  const [homePath, setHomePath] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    void window.piDesktop.system.getPath('home').then((p) => {
      if (!cancelled) setHomePath(p)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (selectedId === null) return
    if (workspaces.some((w) => w.id === selectedId)) return
    setSelectedId(activeWorkspace?.id ?? sorted[0]?.id ?? null)
  }, [activeWorkspace?.id, selectedId, sorted, workspaces])

  useEffect(() => {
    if (!pickerOpen) return
    const onDoc = (e: MouseEvent): void => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [pickerOpen])

  const selected: Workspace | null =
    selectedId === null ? null : (workspaces.find((w) => w.id === selectedId) ?? null)

  const ensureHomeWorkspace = async (): Promise<Workspace | null> => {
    const home = homePath ?? (await window.piDesktop.system.getPath('home'))
    if (!homePath) setHomePath(home)
    const existing = useAppStore.getState().workspaces.find((w) => pathsEqual(w.path, home))
    if (existing) return existing
    await createWorkspace('Home', home)
    return useAppStore.getState().workspaces.find((w) => pathsEqual(w.path, home)) ?? null
  }

  const applySelection = async (id: string | null): Promise<void> => {
    const previousId = selectedId
    setSelectedId(id)
    setPickerOpen(false)
    setBusy(true)
    try {
      if (id) {
        if (!(await switchWorkspace(id, { skipSessionLoad: true }))) {
          setSelectedId(previousId)
        }
      } else {
        const homeWs = await ensureHomeWorkspace()
        if (homeWs) {
          if (!(await switchWorkspace(homeWs.id, { skipSessionLoad: true }))) {
            setSelectedId(previousId)
          }
        } else {
          await startPi()
        }
      }
    } catch {
      setSelectedId(previousId)
    } finally {
      setBusy(false)
    }
  }

  const openFolder = async (): Promise<void> => {
    const path = await window.piDesktop.system.openDialog({ title: 'Open Folder' })
    if (!path) return
    setBusy(true)
    try {
      let ws = useAppStore.getState().workspaces.find((w) => pathsEqual(w.path, path))
      if (!ws) {
        const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path
        await createWorkspace(name, path)
        ws = useAppStore.getState().workspaces.find((w) => pathsEqual(w.path, path))
      }
      if (ws) await applySelection(ws.id)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      ref={pickerRef}
      className={clsx('relative mt-1.5 flex justify-start px-1.5', busy && 'pointer-events-none opacity-60')}
    >
      <button
        type="button"
        onClick={() => setPickerOpen((o) => !o)}
        disabled={busy}
        className="flex max-w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-xs text-secondary hover:bg-highlight-strong transition-colors disabled:opacity-50"
        title={selected?.path ?? homePath ?? 'No project — home directory'}
      >
        {selected ? (
          <Layers size={14} className="shrink-0" style={{ color: selected.color }} />
        ) : (
          <Layers size={14} className="shrink-0 text-faint" />
        )}
        <span className={clsx('min-w-0 truncate font-medium', selected ? 'text-primary' : 'text-dim')}>
          {selected?.name ?? 'No project'}
        </span>
        <ChevronDown
          size={12}
          className={clsx('shrink-0 text-dim transition-transform', pickerOpen && 'rotate-180')}
        />
      </button>

      {pickerOpen && (
        <div className="absolute left-1.5 top-full z-30 mt-1 max-h-64 w-72 overflow-y-auto rounded-lg border border-border-strong bg-surface py-1 shadow-xl shadow-black/40">
          <button
            type="button"
            onClick={() => void applySelection(null)}
            className={clsx(
              'flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-surface-hover transition-colors',
              selectedId === null && 'bg-card'
            )}
          >
            <Layers size={13} className="shrink-0 text-faint" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm text-primary">No project</div>
              <div className="truncate text-[11px] text-faint">{homePath ?? 'Your home directory'}</div>
            </div>
            {selectedId === null && <Check size={12} className="shrink-0 text-success" />}
          </button>
          {sorted.length > 0 && <div className="my-1 border-t border-border" />}
          {sorted.map((ws) => (
            <button
              key={ws.id}
              type="button"
              onClick={() => void applySelection(ws.id)}
              className={clsx(
                'flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-surface-hover transition-colors',
                ws.id === selected?.id && 'bg-card'
              )}
            >
              <Layers size={13} className="shrink-0" style={{ color: ws.color }} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-primary">{ws.name}</div>
                <div className="truncate text-[11px] text-faint">{ws.path}</div>
              </div>
              {ws.id === selected?.id && <Check size={12} className="shrink-0 text-success" />}
            </button>
          ))}
          <div className="my-1 border-t border-border" />
          <button
            type="button"
            onClick={() => void openFolder()}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-secondary hover:bg-surface-hover transition-colors"
          >
            <FolderOpen size={13} className="shrink-0 text-muted" />
            Open folder…
          </button>
        </div>
      )}
    </div>
  )
}
