import type { GitAvailability } from '../../../shared/ipc-contracts'

/** Opened by "How to install"; the app never installs git itself. */
export const GIT_DOWNLOAD_URL = 'https://git-scm.com/downloads'

/** The git banner shows for a missing or broken git until the user dismisses it. */
export function shouldShowGitBanner(availability: GitAvailability | null, dismissed: boolean): boolean {
  return !dismissed && (availability?.status === 'missing' || availability?.status === 'failed')
}
