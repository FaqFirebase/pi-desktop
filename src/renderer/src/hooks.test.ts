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

// hooks.ts pulls in the store, which reaches for the preload bridge inside its
// actions. A bare stub is enough to import the module under test.
before(async () => {
  ;(globalThis as unknown as { window: unknown }).window = { piDesktop: {} }
  ;({ isGlobalWorkflowOpen } = await import('./hooks'))
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
