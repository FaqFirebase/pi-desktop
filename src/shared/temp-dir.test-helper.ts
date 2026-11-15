import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The temp folders this test process made. The test runner gives each test
 * file its own process, so the exit of that process is the end of the file.
 */
const createdTempDirs = new Set<string>()

/**
 * Remove every temp folder of this process. On Linux /tmp is often in RAM, so
 * a folder a test keeps uses memory until the next reboot, and each suite run
 * adds hundreds more. A folder that cannot be removed is named on stderr.
 */
function removeCreatedTempDirs(): void {
  for (const dir of createdTempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (error) {
      process.stderr.write(`Could not remove the test temp folder ${dir}: ${String(error)}\n`)
    }
  }
  createdTempDirs.clear()
}

// 'exit' runs whether the tests pass or fail; its handlers must be synchronous.
process.once('exit', removeCreatedTempDirs)

/** A new empty folder in the system temp folder, removed when the test file ends. */
export function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  createdTempDirs.add(dir)
  return dir
}
