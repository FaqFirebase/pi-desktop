import { useState, useMemo, useEffect } from 'react'
import { clsx } from 'clsx'
import { Plus, Search, Pencil, Trash2, CornerDownLeft, Tag, ArrowLeft } from 'lucide-react'
import { useAppStore } from '../store'
import { MarkdownRenderer } from './markdown-renderer'
import type { Note, NoteInput } from '../../../shared/ipc-contracts'

const GLOBAL_SCOPE = 'global'

/** Split a free-text tag field into normalized tag tokens. */
function parseTags(raw: string): string[] {
  return [...new Set(
    raw
      .split(/[\s,]+/)
      .map((t) => t.trim().toLowerCase().replace(/^#/, ''))
      .filter((t) => t.length > 0)
  )]
}

export function NotesPanel(): React.JSX.Element {
  const notes = useAppStore((state) => state.notes)
  const activeWorkspace = useAppStore((state) => state.activeWorkspace)
  const saveNote = useAppStore((state) => state.saveNote)
  const updateNote = useAppStore((state) => state.updateNote)
  const deleteNote = useAppStore((state) => state.deleteNote)
  const insertPrompt = useAppStore((state) => state.insertPrompt)
  const setCurrentView = useAppStore((state) => state.setCurrentView)
  const noteDraft = useAppStore((state) => state.noteDraft)
  const clearNoteDraft = useAppStore((state) => state.clearNoteDraft)

  const [query, setQuery] = useState('')
  // null = list; 'new' = create form; Note = edit form
  const [editing, setEditing] = useState<'new' | Note | null>(null)
  // Read view: the note being viewed (formatted markdown), or null for the list.
  const [viewing, setViewing] = useState<Note | null>(null)

  // A draft captured elsewhere (e.g. "Add to Notes" from a message) opens the
  // create form pre-filled with that text.
  useEffect(() => {
    if (noteDraft !== null) setEditing('new')
  }, [noteDraft])

  const leaveForm = (): void => {
    setEditing(null)
    if (noteDraft !== null) clearNoteDraft()
  }

  const scopeLabel = (scope: string): string =>
    scope === GLOBAL_SCOPE
      ? 'Global'
      : scope === activeWorkspace?.id
        ? (activeWorkspace?.name ?? 'Workspace')
        : 'Other workspace'

  // Only global notes and notes for the active workspace are relevant here.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return notes
      .filter((n) => n.scope === GLOBAL_SCOPE || n.scope === activeWorkspace?.id)
      .filter((n) => {
        if (!q) return true
        return (
          n.title.toLowerCase().includes(q) ||
          n.body.toLowerCase().includes(q) ||
          n.tags.some((t) => t.includes(q))
        )
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [notes, query, activeWorkspace?.id])

  if (editing !== null) {
    return (
      <NoteForm
        note={editing === 'new' ? null : editing}
        initialBody={editing === 'new' ? (noteDraft ?? '') : ''}
        workspaceId={activeWorkspace?.id ?? null}
        workspaceName={activeWorkspace?.name ?? null}
        onCancel={leaveForm}
        onSubmit={async (input) => {
          if (editing === 'new') {
            await saveNote(input)
          } else {
            await updateNote(editing.id, input)
          }
          leaveForm()
        }}
      />
    )
  }

  if (viewing !== null) {
    return (
      <NoteReadView
        note={viewing}
        scope={scopeLabel(viewing.scope)}
        onBack={() => setViewing(null)}
        onInsert={() => insertPrompt(viewing.body)}
        onEdit={() => { setEditing(viewing); setViewing(null) }}
        onDelete={async () => { await deleteNote(viewing.id); setViewing(null) }}
      />
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setCurrentView('chat')}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 transition-colors"
            title="Back to chat"
          >
            <ArrowLeft size={13} />
            Back to chat
          </button>
          <h1 className="text-sm font-medium text-neutral-200">Notes</h1>
        </div>
        <button
          onClick={() => setEditing('new')}
          className="flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-500 transition-colors"
        >
          <Plus size={13} />
          New Note
        </button>
      </div>

      {/* Search */}
      <div className="px-4 py-3">
        <div className="flex items-center gap-2 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2">
          <Search size={14} className="shrink-0 text-neutral-500" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search title, body, or tag..."
            className="flex-1 bg-transparent text-sm text-neutral-200 placeholder:text-neutral-600 outline-none"
          />
        </div>
      </div>

      {/* List */}
      <div className="flex-1 space-y-2 overflow-y-auto px-4 pb-6">
        {visible.length === 0 ? (
          <div className="mt-8 text-center text-sm text-neutral-600">
            {query.trim() ? 'No notes match your search.' : 'No notes yet. Create one to reuse prompts.'}
          </div>
        ) : (
          visible.map((note) => (
            <div
              key={note.id}
              className="group rounded-md border border-neutral-800 bg-neutral-900 p-3 hover:border-neutral-700 transition-colors"
            >
              <button
                onClick={() => setViewing(note)}
                className="block w-full text-left"
                title="View note"
              >
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-neutral-200">{note.title}</span>
                  <span
                    className={clsx(
                      'shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide',
                      note.scope === GLOBAL_SCOPE
                        ? 'bg-neutral-800 text-neutral-400'
                        : 'bg-blue-950 text-blue-300'
                    )}
                  >
                    {scopeLabel(note.scope)}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-xs text-neutral-500">{note.body}</p>
                {note.tags.length > 0 && (
                  <div className="mt-2 flex flex-wrap items-center gap-1">
                    <Tag size={10} className="text-neutral-600" />
                    {note.tags.map((tag) => (
                      <span key={tag} className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400">
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </button>

              <div className="mt-2 flex items-center gap-1">
                <button
                  onClick={() => insertPrompt(note.body)}
                  className="flex items-center gap-1 rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors"
                  title="Insert into chat input"
                >
                  <CornerDownLeft size={11} />
                  Insert
                </button>
                <button
                  onClick={() => setEditing(note)}
                  className="rounded p-1 text-neutral-500 hover:text-neutral-300 transition-colors"
                  title="Edit note"
                  aria-label="Edit note"
                >
                  <Pencil size={13} />
                </button>
                <button
                  onClick={() => deleteNote(note.id)}
                  className="rounded p-1 text-neutral-500 hover:text-red-400 transition-colors"
                  title="Delete note"
                  aria-label="Delete note"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

// ─── Note Read View ─────────────────────────────────────────────────────────

function NoteReadView({
  note,
  scope,
  onBack,
  onInsert,
  onEdit,
  onDelete,
}: {
  note: Note
  scope: string
  onBack: () => void
  onInsert: () => void
  onEdit: () => void
  onDelete: () => void
}): React.JSX.Element {
  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 border-b border-neutral-800 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <button
            onClick={onBack}
            className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 transition-colors"
            title="Back to notes"
          >
            <ArrowLeft size={13} />
            Back
          </button>
          <h1 className="truncate text-sm font-medium text-neutral-200">{note.title}</h1>
          <span className="shrink-0 rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-neutral-400">
            {scope}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={onInsert}
            className="flex items-center gap-1 rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors"
            title="Insert into chat input"
          >
            <CornerDownLeft size={11} />
            Insert
          </button>
          <button
            onClick={onEdit}
            className="rounded p-1 text-neutral-500 hover:text-neutral-300 transition-colors"
            title="Edit note"
            aria-label="Edit note"
          >
            <Pencil size={13} />
          </button>
          <button
            onClick={onDelete}
            className="rounded p-1 text-neutral-500 hover:text-red-400 transition-colors"
            title="Delete note"
            aria-label="Delete note"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {/* Tags */}
      {note.tags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 border-b border-neutral-800/60 px-4 py-2">
          <Tag size={11} className="text-neutral-600" />
          {note.tags.map((tag) => (
            <span key={tag} className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400">
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Rendered body — markdown with preserved indents, line breaks, code blocks */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="markdown-body text-sm text-neutral-200">
          <MarkdownRenderer content={note.body} />
        </div>
      </div>
    </div>
  )
}

// ─── Note Form ────────────────────────────────────────────────────────────────

function NoteForm({
  note,
  initialBody,
  workspaceId,
  workspaceName,
  onSubmit,
  onCancel,
}: {
  note: Note | null
  initialBody: string
  workspaceId: string | null
  workspaceName: string | null
  onSubmit: (input: NoteInput) => Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  const [title, setTitle] = useState(note?.title ?? '')
  const [body, setBody] = useState(note?.body ?? initialBody)
  const [tagsRaw, setTagsRaw] = useState(note?.tags.join(' ') ?? '')
  const [scope, setScope] = useState<string>(note?.scope ?? GLOBAL_SCOPE)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const canSave = title.trim().length > 0 && body.trim().length > 0 && !saving

  const handleSubmit = async (): Promise<void> => {
    if (!canSave) return
    setSaving(true)
    setError(null)
    try {
      await onSubmit({ title: title.trim(), body: body.trim(), tags: parseTags(tagsRaw), scope })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save note')
      setSaving(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-neutral-800 px-4 py-3">
        <h1 className="text-sm font-medium text-neutral-200">{note ? 'Edit Note' : 'New Note'}</h1>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-neutral-400">Title</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Refactor with tests"
            className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-blue-500 focus:outline-none"
            autoFocus
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-neutral-400">Prompt / Command</label>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="The reusable prompt or command text..."
            rows={8}
            className="w-full resize-y rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-blue-500 focus:outline-none"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-neutral-400">Tags</label>
          <input
            type="text"
            value={tagsRaw}
            onChange={(e) => setTagsRaw(e.target.value)}
            placeholder="space or comma separated"
            className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-blue-500 focus:outline-none"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-neutral-400">Scope</label>
          <div className="flex gap-2">
            <ScopeButton active={scope === GLOBAL_SCOPE} onClick={() => setScope(GLOBAL_SCOPE)} label="Global" />
            {workspaceId && (
              <ScopeButton
                active={scope === workspaceId}
                onClick={() => setScope(workspaceId)}
                label={workspaceName ?? 'This workspace'}
              />
            )}
          </div>
        </div>

        {error && <div className="rounded-md bg-red-950 px-3 py-2 text-xs text-red-300">{error}</div>}
      </div>

      <div className="flex items-center gap-2 border-t border-neutral-800 px-4 py-3">
        <button
          onClick={handleSubmit}
          disabled={!canSave}
          className="rounded-md bg-blue-600 px-4 py-1.5 text-sm text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button
          onClick={onCancel}
          className="rounded-md px-4 py-1.5 text-sm text-neutral-400 hover:text-neutral-200 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

function ScopeButton({
  active,
  onClick,
  label,
}: {
  active: boolean
  onClick: () => void
  label: string
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'rounded-md border px-3 py-1.5 text-xs transition-colors',
        active
          ? 'border-blue-500 bg-blue-950 text-blue-200'
          : 'border-neutral-700 bg-neutral-900 text-neutral-400 hover:text-neutral-200'
      )}
    >
      {label}
    </button>
  )
}
