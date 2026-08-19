import { useEffect, useRef, useState } from 'react'
import { Layers, Play, X } from 'lucide-react'
import { useAppStore } from '../store'

export function TaskLauncher(): React.JSX.Element | null {
  const open = useAppStore((state) => state.taskLauncherOpen)
  const setOpen = useAppStore((state) => state.setTaskLauncherOpen)
  const workspaces = useAppStore((state) => state.workspaces)
  const activeWorkspace = useAppStore((state) => state.activeWorkspace)
  const launchTask = useAppStore((state) => state.launchTask)
  const [workspaceId, setWorkspaceId] = useState('')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!open) return
    setWorkspaceId(activeWorkspace?.id ?? workspaces[0]?.id ?? '')
    setPrompt('')
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [open, activeWorkspace?.id, workspaces])

  if (!open) return null

  const close = (): void => {
    if (!busy) setOpen(false)
  }

  const submit = async (): Promise<void> => {
    if (!workspaceId || !prompt.trim() || busy) return
    setBusy(true)
    const launched = await launchTask({ workspaceId, prompt })
    setBusy(false)
    if (launched) setOpen(false)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 px-4 pt-[12vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
      role="presentation"
    >
      <section
        className="w-full max-w-xl overflow-hidden rounded-xl border border-border-strong bg-surface shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-launcher-title"
      >
        <div className="flex items-start justify-between border-b border-border px-5 py-4">
          <div>
            <div className="flex items-center gap-2">
              <Play size={16} className="text-accent-fg" />
              <h2 id="task-launcher-title" className="text-sm font-semibold text-primary">New task</h2>
            </div>
            <p className="mt-1 text-xs text-dim">Start a fresh Pi session and send the task immediately.</p>
          </div>
          <button
            type="button"
            onClick={close}
            disabled={busy}
            className="rounded p-1 text-faint transition-colors hover:bg-surface-hover hover:text-primary disabled:opacity-50"
            aria-label="Close task launcher"
          >
            <X size={15} />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-secondary">Project</span>
            <span className="flex items-center gap-2 rounded-md border border-border bg-app px-3 py-2">
              <Layers size={14} className="shrink-0 text-muted" />
              <select
                value={workspaceId}
                onChange={(event) => setWorkspaceId(event.target.value)}
                disabled={busy || workspaces.length === 0}
                className="min-w-0 flex-1 bg-transparent text-sm text-primary outline-none"
              >
                {workspaces.length === 0 && <option value="">Open a project first</option>}
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
                ))}
              </select>
            </span>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-secondary">Task</span>
            <textarea
              ref={inputRef}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault()
                  void submit()
                }
              }}
              placeholder="Fix the failing tests, explain the root cause, and prepare the changes for review…"
              rows={6}
              disabled={busy}
              className="w-full resize-y rounded-md border border-border bg-app px-3 py-2 text-sm leading-relaxed text-primary outline-none placeholder:text-faint focus:border-focus"
            />
          </label>

          <p className="text-[11px] text-faint">
            The task runs in a new session and continues in the background if you switch away. Use the isolated Git tab button when file isolation is required.
          </p>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border bg-app/40 px-5 py-3">
          <button
            type="button"
            onClick={close}
            disabled={busy}
            className="rounded-md px-3 py-1.5 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-primary disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !workspaceId || !prompt.trim()}
            className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Play size={12} />
            {busy ? 'Starting…' : 'Start task'}
          </button>
        </div>
      </section>
    </div>
  )
}
