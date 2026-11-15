import { LOG_EXPORT_FORMAT, type AppLogEntry, type DiagnosticsReport, type LogExportFile } from '../shared/ipc-contracts'
import { redactLogEntry } from './log-redaction'

export const LOG_EXPORT_FILE_PREFIX = 'pi-desktop-logs'
export const LOG_EXPORT_EXTENSION = 'json'
const DATE_PART_WIDTH = 2
const JSON_INDENT = 2

function datePart(value: number): string {
  return String(value).padStart(DATE_PART_WIDTH, '0')
}

/** `pi-desktop-logs-YYYY-MM-DD.json`, in the local date. */
export function logExportFileName(date: Date): string {
  const day = `${date.getFullYear()}-${datePart(date.getMonth() + 1)}-${datePart(date.getDate())}`
  return `${LOG_EXPORT_FILE_PREFIX}-${day}.${LOG_EXPORT_EXTENSION}`
}

export function buildLogExport(input: {
  diagnostics: DiagnosticsReport
  current: AppLogEntry[]
  previous: AppLogEntry[]
  secretValues: readonly string[]
  exportedAt: number
}): LogExportFile {
  const redact = (entries: AppLogEntry[]): AppLogEntry[] => entries.map((entry) => redactLogEntry(entry, input.secretValues))
  return {
    format: LOG_EXPORT_FORMAT,
    exportedAt: input.exportedAt,
    diagnostics: { ...input.diagnostics, recentErrors: redact(input.diagnostics.recentErrors) },
    log: { current: redact(input.current), previous: redact(input.previous) },
  }
}

export function serializeLogExport(file: LogExportFile): string {
  return JSON.stringify(file, null, JSON_INDENT) + '\n'
}
