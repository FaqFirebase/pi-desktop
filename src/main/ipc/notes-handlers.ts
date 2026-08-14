import { ipcMain } from 'electron'
import type { NoteInput, NoteUpdate, NoteScope } from '../../shared/ipc-contracts'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import { isString, isObject, parseStringArray } from './validation'
import type { IpcContext } from './context'

/** Validate the shape of a NoteInput from the renderer (content checks happen in NotesManager). */
function parseNoteInput(value: unknown): NoteInput {
  if (!isObject(value)) throw new Error('note must be an object')
  if (!isString(value.title)) throw new Error('note.title must be a string')
  if (!isString(value.body)) throw new Error('note.body must be a string')
  if (!isString(value.scope)) throw new Error('note.scope must be a string')
  return {
    title: value.title,
    body: value.body,
    scope: value.scope as NoteScope,
    tags: parseStringArray(value.tags, 'note.tags'),
  }
}

/** Validate a partial NoteUpdate; only supplied fields are carried through. */
function parseNoteUpdate(value: unknown): NoteUpdate {
  if (!isObject(value)) throw new Error('patch must be an object')
  const patch: NoteUpdate = {}
  if (value.title !== undefined) {
    if (!isString(value.title)) throw new Error('note.title must be a string')
    patch.title = value.title
  }
  if (value.body !== undefined) {
    if (!isString(value.body)) throw new Error('note.body must be a string')
    patch.body = value.body
  }
  if (value.scope !== undefined) {
    if (!isString(value.scope)) throw new Error('note.scope must be a string')
    patch.scope = value.scope as NoteScope
  }
  if (value.tags !== undefined) {
    patch.tags = parseStringArray(value.tags, 'note.tags')
  }
  return patch
}

export function registerNotesHandlers(ctx: IpcContext): void {
  const { notesManager } = ctx

  // ─── Notes (reusable prompts / commands) ──────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.NOTES_LIST, async () => {
    return notesManager.list()
  })

  ipcMain.handle(IPC_CHANNELS.NOTES_CREATE, async (_event, input: unknown) => {
    return notesManager.create(parseNoteInput(input))
  })

  ipcMain.handle(IPC_CHANNELS.NOTES_UPDATE, async (_event, id: unknown, patch: unknown) => {
    if (!isString(id)) throw new Error('id must be a string')
    return notesManager.update(id, parseNoteUpdate(patch))
  })

  ipcMain.handle(IPC_CHANNELS.NOTES_REMOVE, async (_event, id: unknown) => {
    if (!isString(id)) throw new Error('id must be a string')
    await notesManager.remove(id)
  })
}
