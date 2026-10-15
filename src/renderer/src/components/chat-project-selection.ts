import type { Workspace } from '../../../shared/ipc-contracts'
import { pathsEqual } from '../../../shared/path-compare'

/** The composer always targets the active workspace; home means “No project”. */
export function chatProjectSelection(
  activeWorkspace: Workspace | null,
  homePath: string | null
): Workspace | null {
  if (!activeWorkspace || (homePath && pathsEqual(activeWorkspace.path, homePath))) return null
  return activeWorkspace
}
