import { ipcMain, app } from 'electron'
import type { UpdateCheckResult } from '../../shared/ipc-contracts'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import { appLog } from '../app-log'

const UPDATE_REPO = 'FaqFirebase/pi-desktop'
const UPDATE_CHECK_TIMEOUT_MS = 8000

interface GithubRelease {
  tag_name: string
  html_url: string
  name: string | null
  draft: boolean
  prerelease: boolean
}

/** Parse a version like "0.0.5-alpha" into numeric core + prerelease tag. */
function parseVersion(version: string): { core: number[]; pre: string } {
  const clean = version.replace(/^v/, '').trim()
  const [core, pre = ''] = clean.split('-')
  const nums = core.split('.').map((n) => parseInt(n, 10) || 0)
  while (nums.length < 3) nums.push(0)
  return { core: nums.slice(0, 3), pre }
}

/**
 * True when `latest` is a newer version than `current`. Handles the project's
 * `x.y.z-prerelease` scheme: a release with no prerelease tag outranks one with
 * the same core that has a tag; two prerelease tags compare lexically
 * (alpha < beta < rc).
 */
function isNewerVersion(latest: string, current: string): boolean {
  const a = parseVersion(latest)
  const b = parseVersion(current)
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i]
  }
  if (a.pre === b.pre) return false
  if (!a.pre) return true
  if (!b.pre) return false
  return a.pre > b.pre
}

/** Check GitHub releases (including prereleases) for a version newer than this build. */
async function checkForUpdate(): Promise<UpdateCheckResult> {
  const currentVersion = app.getVersion()
  const noUpdate: UpdateCheckResult = { updateAvailable: false, currentVersion, latestVersion: currentVersion, url: '' }

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS)
    const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases?per_page=10`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Pi-Desktop' },
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!res.ok) return noUpdate

    const releases = (await res.json()) as GithubRelease[]
    const published = releases.filter((r) => !r.draft)
    if (published.length === 0) return noUpdate

    // Pick the highest version among published releases (not just newest by date).
    let latest = published[0]
    for (const r of published) {
      if (isNewerVersion(r.tag_name.replace(/^v/, ''), latest.tag_name.replace(/^v/, ''))) latest = r
    }

    const latestVersion = latest.tag_name.replace(/^v/, '')
    return {
      updateAvailable: isNewerVersion(latestVersion, currentVersion),
      currentVersion,
      latestVersion,
      url: latest.html_url,
      name: latest.name ?? latest.tag_name,
    }
  } catch (err) {
    appLog.warn('updates', 'Update check failed', err)
    return noUpdate
  }
}

export function registerUpdateHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.UPDATE_CHECK, async (): Promise<UpdateCheckResult> => {
    return checkForUpdate()
  })
}
