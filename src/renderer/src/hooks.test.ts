import { test, before } from 'node:test'
import assert from 'node:assert/strict'

// The scope snapshot the predicate reads, mirroring the store's fields.
interface WorkflowPanelScope {
  workflowPanelOpen: boolean
  workflowPanelFilter: string | null
  workflowPanelWorkspaceId: string | null
}

const SESSION_ID = 'ba5eba11-0000-4000-8000-000000000001'
const WORKSPACE_ID = 'ws-1'

let isGlobalWorkflowOpen: (scope: WorkflowPanelScope) => boolean
let isAbortShortcut: (event: { key: string; defaultPrevented: boolean }, isStreaming: boolean) => boolean
let isFileWatchDemanded: (
  scope: WorkflowPanelScope & { currentView: string; chatSidePanel: 'files' | 'diff' | 'tasks' | null }
) => boolean
let sessionTabToClose: (
  state: WorkflowPanelScope & { currentView: string; activeSessionRuntimeId: string | null }
) => string | null

const RUNTIME_ID = 'runtime-1'
const NO_WORKFLOW_PANEL: WorkflowPanelScope = {
  workflowPanelOpen: false,
  workflowPanelFilter: null,
  workflowPanelWorkspaceId: null,
}

// hooks.ts pulls in the store, which reaches for the preload bridge inside its
// actions. A bare stub is enough to import the module under test.
before(async () => {
  ;(globalThis as unknown as { window: unknown }).window = { piDesktop: {} }
  ;({ isGlobalWorkflowOpen, isAbortShortcut, isFileWatchDemanded, sessionTabToClose } = await import('./hooks'))
})

test('the workspace is watched only while a files or diff panel is on screen', () => {
  const chat = { ...NO_WORKFLOW_PANEL, currentView: 'chat' }
  assert.equal(isFileWatchDemanded({ ...chat, chatSidePanel: 'files' }), true)
  assert.equal(isFileWatchDemanded({ ...chat, chatSidePanel: 'diff' }), true)
  assert.equal(isFileWatchDemanded({ ...chat, chatSidePanel: null }), false)
  // The Tasks panel reads no workspace files, so it must not start the watcher.
  assert.equal(isFileWatchDemanded({ ...chat, chatSidePanel: 'tasks' }), false)
  // The chat's panes stay mounted behind another view, but nobody sees them.
  assert.equal(isFileWatchDemanded({ ...NO_WORKFLOW_PANEL, currentView: 'settings', chatSidePanel: 'diff' }), false)
  assert.equal(isFileWatchDemanded({ ...NO_WORKFLOW_PANEL, currentView: 'diff', chatSidePanel: null }), true)
  const globalWorkflow = { workflowPanelOpen: true, workflowPanelFilter: null, workflowPanelWorkspaceId: null }
  assert.equal(isFileWatchDemanded({ ...globalWorkflow, currentView: 'diff', chatSidePanel: null }), false)
  assert.equal(isFileWatchDemanded({ ...globalWorkflow, currentView: 'chat', chatSidePanel: 'files' }), false)
})

test('an unscoped open panel is the global workflow view', () => {
  assert.equal(
    isGlobalWorkflowOpen({
      workflowPanelOpen: true,
      workflowPanelFilter: null,
      workflowPanelWorkspaceId: null,
    }),
    true
  )
})

test('a session-scoped panel is not the global view', () => {
  assert.equal(
    isGlobalWorkflowOpen({
      workflowPanelOpen: true,
      workflowPanelFilter: SESSION_ID,
      workflowPanelWorkspaceId: null,
    }),
    false
  )
})

test('a project-scoped panel is not the global view', () => {
  assert.equal(
    isGlobalWorkflowOpen({
      workflowPanelOpen: true,
      workflowPanelFilter: null,
      workflowPanelWorkspaceId: WORKSPACE_ID,
    }),
    false
  )
})

// Closing the panel preserves its scope so a reopen lands in the same place;
// the surfaces behind it must come back regardless of the scope left behind.
test('a closed panel is never the global view, whatever scope it kept', () => {
  for (const scope of [null, WORKSPACE_ID]) {
    assert.equal(
      isGlobalWorkflowOpen({
        workflowPanelOpen: false,
        workflowPanelFilter: null,
        workflowPanelWorkspaceId: scope,
      }),
      false
    )
  }
  assert.equal(
    isGlobalWorkflowOpen({
      workflowPanelOpen: false,
      workflowPanelFilter: SESSION_ID,
      workflowPanelWorkspaceId: null,
    }),
    false
  )
})

test('Escape aborts a streaming turn', () => {
  assert.equal(isAbortShortcut({ key: 'Escape', defaultPrevented: false }, true), true)
  assert.equal(isAbortShortcut({ key: 'Escape', defaultPrevented: false }, false), false)
  assert.equal(isAbortShortcut({ key: 'Enter', defaultPrevented: false }, true), false)
})

test('Escape already consumed by another surface does not abort the turn', () => {
  assert.equal(isAbortShortcut({ key: 'Escape', defaultPrevented: true }, true), false)
})

test('the close shortcut targets the active session tab while chat is on screen', () => {
  assert.equal(
    sessionTabToClose({ ...NO_WORKFLOW_PANEL, currentView: 'chat', activeSessionRuntimeId: RUNTIME_ID }),
    RUNTIME_ID
  )
  assert.equal(
    sessionTabToClose({ ...NO_WORKFLOW_PANEL, currentView: 'chat', activeSessionRuntimeId: null }),
    null
  )
})

test('the close shortcut never closes a tab hidden behind another view', () => {
  assert.equal(
    sessionTabToClose({ ...NO_WORKFLOW_PANEL, currentView: 'settings', activeSessionRuntimeId: RUNTIME_ID }),
    null
  )
  assert.equal(
    sessionTabToClose({
      workflowPanelOpen: true,
      workflowPanelFilter: null,
      workflowPanelWorkspaceId: null,
      currentView: 'chat',
      activeSessionRuntimeId: RUNTIME_ID,
    }),
    null,
    'the global workflow view covers the chat'
  )
})
