import { Plus, Trash2, Upload, Download } from 'lucide-react'
import type { PermissionRule, PermissionRuleAction } from '../../../shared/ipc-contracts'
import { emptyRule } from './permission-rules-editor-helpers'

const TOOL_SUGGESTIONS = ['*', 'bash', 'edit', 'write', 'read', 'grep'] as const
const TOOL_DATALIST_ID = 'permission-rule-tool-suggestions'

interface PermissionRulesEditorProps {
  rules: PermissionRule[]
  onChange: (rules: PermissionRule[]) => void
  onImport: () => void
  onExport: () => void
  workspaceOverride: boolean
  loadError: string | null
  actionError: string | null
}

export function PermissionRulesEditor({
  rules,
  onChange,
  onImport,
  onExport,
  workspaceOverride,
  loadError,
  actionError,
}: PermissionRulesEditorProps): React.JSX.Element {
  const updateRule = (index: number, patch: Partial<PermissionRule>): void => {
    onChange(rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)))
  }

  const removeRule = (index: number): void => {
    onChange(rules.filter((_, i) => i !== index))
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-dim">
          Deny always wins, then allow, then the mode above decides. Use * as a wildcard.
        </span>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={onImport}
            className="flex items-center gap-1 rounded-md border border-border-strong px-2 py-1 text-xs text-primary transition-colors hover:border-border-strong-hover"
            title="Import rules from a JSON file (replaces the list below until you save)"
          >
            <Upload size={12} /> Import
          </button>
          <button
            type="button"
            onClick={onExport}
            className="flex items-center gap-1 rounded-md border border-border-strong px-2 py-1 text-xs text-primary transition-colors hover:border-border-strong-hover"
            title="Export the list below to a JSON file"
          >
            <Download size={12} /> Export
          </button>
        </div>
      </div>

      {workspaceOverride && (
        <p className="rounded-md border border-border-strong bg-surface px-2 py-1.5 text-xs text-dim">
          This workspace has its own rules file (.pi-desktop/permission-rules.json), which replaces
          the global rules below while you work here.
        </p>
      )}

      {loadError && (
        <p
          role="alert"
          className="rounded-md border border-error-bg bg-error-bg px-2 py-1.5 text-xs text-error"
        >
          Saved rules file is invalid and is being ignored: {loadError}
        </p>
      )}

      <datalist id={TOOL_DATALIST_ID}>
        {TOOL_SUGGESTIONS.map((tool) => (
          <option key={tool} value={tool} />
        ))}
      </datalist>

      {rules.length === 0 && (
        <p className="px-1 text-xs text-dim">No rules yet — the mode above decides everything.</p>
      )}

      {rules.map((rule, index) => (
        <div key={index} className="flex items-center gap-1.5">
          <select
            value={rule.action}
            onChange={(e) => updateRule(index, { action: e.target.value as PermissionRuleAction })}
            className="rounded-md border border-border-strong bg-surface px-1.5 py-1 text-xs text-primary"
            aria-label={`Rule ${index + 1} action`}
          >
            <option value="allow">Allow</option>
            <option value="deny">Deny</option>
          </select>
          <input
            type="text"
            value={rule.tool}
            onChange={(e) => updateRule(index, { tool: e.target.value })}
            list={TOOL_DATALIST_ID}
            placeholder="tool (* = any)"
            className="w-28 rounded-md border border-border-strong bg-surface px-1.5 py-1 text-xs text-primary placeholder:text-dim"
            aria-label={`Rule ${index + 1} tool`}
          />
          <input
            type="text"
            value={rule.match ?? ''}
            onChange={(e) => updateRule(index, { match: e.target.value })}
            placeholder="pattern, e.g. npm test* (empty = any input)"
            className="min-w-0 flex-1 rounded-md border border-border-strong bg-surface px-1.5 py-1 font-mono text-xs text-primary placeholder:text-dim"
            aria-label={`Rule ${index + 1} pattern`}
          />
          <button
            type="button"
            onClick={() => removeRule(index)}
            className="shrink-0 rounded-md p-1 text-dim transition-colors hover:text-error"
            title="Remove rule"
            aria-label={`Remove rule ${index + 1}`}
          >
            <Trash2 size={13} />
          </button>
        </div>
      ))}

      <button
        type="button"
        onClick={() => onChange([...rules, emptyRule()])}
        className="flex items-center gap-1 rounded-md border border-dashed border-border-strong px-2 py-1 text-xs text-dim transition-colors hover:border-border-strong-hover hover:text-primary"
      >
        <Plus size={12} /> Add rule
      </button>

      {actionError && (
        <p role="alert" className="text-xs text-error">
          {actionError}
        </p>
      )}
    </div>
  )
}
