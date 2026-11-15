import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LOG_EXPORT_FORMAT, type DiagnosticsReport } from '../shared/ipc-contracts'
import { buildLogExport, logExportFileName, serializeLogExport } from './log-export'

function report(overrides: Partial<DiagnosticsReport>): DiagnosticsReport {
  return {
    generatedAt: 1,
    app: { version: '0.1.9', electron: '43', chrome: '140', node: '22', platform: 'linux' },
    piBinary: {
      found: true,
      script: '/usr/bin/pi',
      source: 'path',
      useNode: false,
      nodeBinary: 'node',
      nodeFound: true,
      needsShell: false,
      rejectedOverride: null,
      failureReason: null,
      pathEntryCount: 3,
    },
    piVersion: '1.0.0',
    git: { status: 'found', version: 'git version 2.47.0' },
    workspaces: [],
    providers: null,
    providersError: null,
    permissions: {
      mode: 'ask-edits',
      globalRuleCount: 0,
      globalRulesError: null,
      workspace: { hasWorkspaceRules: false, workspacePath: null, acknowledged: false, trusted: false, hasAllowRules: false },
    },
    storage: { guiDataDir: '/data', settingsPath: '/data/settings.json', sessionsRoot: '/sessions', sessionsRootExists: true },
    recentErrors: [],
    ...overrides,
  }
}

test('file name carries the local date', () => {
  assert.equal(logExportFileName(new Date(2026, 10, 4, 23, 59)), 'pi-desktop-logs-2026-11-04.json')
})

test("export redacts log entries and the report's recentErrors", () => {
  const leak = { ts: 1, level: 'warn' as const, scope: 'git', message: 'https://u:p4ssw0rd@host/x', detail: 'api_key=abcdefgh' }
  const file = buildLogExport({ diagnostics: report({ recentErrors: [leak] }), current: [leak], previous: [leak], secretValues: [], exportedAt: 5 })
  assert.equal(file.format, LOG_EXPORT_FORMAT)
  assert.equal(file.exportedAt, 5)
  for (const entry of [file.log.current[0], file.log.previous[0], file.diagnostics.recentErrors[0]]) {
    assert.equal(entry.message, 'https://[redacted]@host/x')
    assert.equal(entry.detail, 'api_key=[redacted]')
  }
})

test('serialized export parses back to the same object', () => {
  const file = buildLogExport({ diagnostics: report({}), current: [], previous: [], secretValues: [], exportedAt: 1 })
  assert.deepEqual(JSON.parse(serializeLogExport(file)), file)
})
