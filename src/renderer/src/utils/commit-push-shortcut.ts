import { useAppStore } from '../store'

export async function requestCommitPushDialog(): Promise<void> {
  const state = useAppStore.getState()
  if (!state.activeWorkspace) return
  const workflowVisible = state.workflowPanelOpen && !state.workflowPanelFilter && state.workflowPanelWorkspaceId === null
  const diffVisible = !workflowVisible && (state.currentView === 'diff' ||
    (state.currentView === 'chat' && state.chatSidePanel === 'diff'))
  if (diffVisible) {
    useAppStore.setState({ diffShortcutRequest: 'commitPush' })
    return
  }
  const opened = await state.setChatSidePanel('diff')
  const current = useAppStore.getState()
  if (!opened || current.activeWorkspace?.id !== state.activeWorkspace.id) return
  current.setWorkflowPanelOpen(false)
  current.setCurrentView('chat')
  useAppStore.setState({ diffShortcutRequest: 'review' })
}
