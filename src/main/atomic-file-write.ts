import { randomUUID } from 'crypto'
import { mkdir, rename, rm, writeFile } from 'fs/promises'
import { dirname } from 'path'

/** Ending of a file written next to its target before it is renamed over it. */
export const TEMP_FILE_SUFFIX = '.tmp'
/** Indent of the JSON files the app writes. */
export const JSON_FILE_INDENT = 2

/** A temp path next to `path`, unique per call, so two writes never share one. */
export function uniqueTempPath(path: string): string {
  return `${path}.${randomUUID()}${TEMP_FILE_SUFFIX}`
}

/**
 * Write `value` as JSON to `path` through a unique temp file and a rename, so
 * a reader sees the old file or the new one, never a part of one.
 */
export async function writeJsonFileAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tempPath = uniqueTempPath(path)
  try {
    await writeFile(tempPath, JSON.stringify(value, null, JSON_FILE_INDENT), 'utf8')
    await rename(tempPath, path)
  } catch (err) {
    await rm(tempPath, { force: true })
    throw err
  }
}
