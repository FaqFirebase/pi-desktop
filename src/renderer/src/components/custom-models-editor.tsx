import { useEffect, useState } from 'react'
import { clsx } from 'clsx'
import { Plus, Trash2, Save, RefreshCw, AlertTriangle } from 'lucide-react'
import { useAppStore } from '../store'
import type { ModelsConfig, CustomModel } from '../../../shared/models-config'

const API_OPTIONS = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
]

interface ProviderRow {
  key: string
  baseUrl: string
  api: string
  apiKey: string
  models: CustomModel[]
}

function configToRows(config: ModelsConfig | null): ProviderRow[] {
  if (!config) return []
  return Object.entries(config.providers ?? {}).map(([key, p]) => ({
    key,
    baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl : '',
    api: typeof p.api === 'string' ? p.api : '',
    apiKey: typeof p.apiKey === 'string' ? p.apiKey : '',
    models: Array.isArray(p.models) ? p.models : [],
  }))
}

function rowsToConfig(rows: ProviderRow[]): ModelsConfig {
  const providers: ModelsConfig['providers'] = {}
  for (const r of rows) {
    providers[r.key.trim()] = {
      ...(r.baseUrl ? { baseUrl: r.baseUrl } : {}),
      ...(r.api ? { api: r.api } : {}),
      ...(r.apiKey ? { apiKey: r.apiKey } : {}),
      models: r.models,
    }
  }
  return { providers }
}

export function CustomModelsEditor(): React.JSX.Element {
  const customModels = useAppStore((s) => s.customModels)
  const customModelsError = useAppStore((s) => s.customModelsError)
  const loadCustomModels = useAppStore((s) => s.loadCustomModels)
  const saveCustomModels = useAppStore((s) => s.saveCustomModels)
  const restartPi = useAppStore((s) => s.restartPi)

  const [rows, setRows] = useState<ProviderRow[]>([])
  const [errors, setErrors] = useState<string[]>([])
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    loadCustomModels()
  }, [loadCustomModels])

  useEffect(() => {
    setRows(configToRows(customModels))
  }, [customModels])

  const update = (next: ProviderRow[]): void => {
    setRows(next)
    setSaved(false)
  }

  const addProvider = (): void =>
    update([...rows, { key: '', baseUrl: '', api: API_OPTIONS[0], apiKey: '', models: [] }])

  const removeProvider = (i: number): void => update(rows.filter((_, idx) => idx !== i))

  const patchProvider = (i: number, patch: Partial<ProviderRow>): void =>
    update(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))

  const addModel = (i: number): void =>
    patchProvider(i, { models: [...rows[i].models, { id: '' }] })

  const patchModel = (pi: number, mi: number, patch: Partial<CustomModel>): void =>
    patchProvider(pi, { models: rows[pi].models.map((m, idx) => (idx === mi ? { ...m, ...patch } : m)) })

  const removeModel = (pi: number, mi: number): void =>
    patchProvider(pi, { models: rows[pi].models.filter((_, idx) => idx !== mi) })

  const handleSave = async (): Promise<void> => {
    // Duplicate/empty provider keys collapse in object form, so check here.
    const keys = rows.map((r) => r.key.trim())
    const localErrors: string[] = []
    if (keys.some((k) => k.length === 0)) localErrors.push('Every provider needs a non-empty key')
    if (new Set(keys).size !== keys.length) localErrors.push('Provider keys must be unique')
    if (localErrors.length > 0) {
      setErrors(localErrors)
      return
    }
    const result = await saveCustomModels(rowsToConfig(rows))
    if (result.ok) {
      setErrors([])
      setSaved(true)
    } else {
      setErrors(result.errors ?? ['Save failed'])
    }
  }

  if (customModelsError) {
    return (
      <div className="flex items-start gap-2 text-sm text-amber-400">
        <AlertTriangle size={16} className="mt-0.5 shrink-0" />
        <div>
          <p>Could not load models.json safely, so editing is disabled to avoid overwriting it.</p>
          <p className="mt-1 text-xs text-neutral-500">{customModelsError}</p>
          <button
            onClick={() => loadCustomModels()}
            className="mt-2 rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-neutral-500">
        Custom providers and models in <code>~/.pi/agent/models.json</code>. Applied when PI restarts.
      </p>

      {rows.map((row, pi) => (
        <div key={pi} className="rounded-md border border-neutral-800 p-3">
          <div className="flex items-center gap-2">
            <input
              value={row.key}
              onChange={(e) => patchProvider(pi, { key: e.target.value })}
              placeholder="provider-key (e.g. ollama)"
              className="flex-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-200 focus:border-blue-500 focus:outline-none"
            />
            <button
              onClick={() => removeProvider(pi)}
              className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-red-400"
              title="Remove provider"
            >
              <Trash2 size={14} />
            </button>
          </div>

          <div className="mt-2 grid grid-cols-2 gap-2">
            <input
              value={row.baseUrl}
              onChange={(e) => patchProvider(pi, { baseUrl: e.target.value })}
              placeholder="baseUrl"
              className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-200 focus:border-blue-500 focus:outline-none"
            />
            <select
              value={row.api}
              onChange={(e) => patchProvider(pi, { api: e.target.value })}
              className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-200 focus:border-blue-500 focus:outline-none"
            >
              {API_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>{opt}</option>
              ))}
            </select>
          </div>
          <input
            value={row.apiKey}
            onChange={(e) => patchProvider(pi, { apiKey: e.target.value })}
            placeholder="apiKey — literal, $ENV_VAR, or !shell-command"
            className="mt-2 w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-200 focus:border-blue-500 focus:outline-none"
          />

          <div className="mt-3 space-y-2">
            {row.models.map((model, mi) => (
              <div key={mi} className="rounded border border-neutral-800 bg-neutral-900/50 p-2">
                <div className="flex items-center gap-2">
                  <input
                    value={model.id ?? ''}
                    onChange={(e) => patchModel(pi, mi, { id: e.target.value })}
                    placeholder="model id (required)"
                    className="flex-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 focus:border-blue-500 focus:outline-none"
                  />
                  <input
                    value={model.name ?? ''}
                    onChange={(e) => patchModel(pi, mi, { name: e.target.value })}
                    placeholder="name"
                    className="flex-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 focus:border-blue-500 focus:outline-none"
                  />
                  <button
                    onClick={() => removeModel(pi, mi)}
                    className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-red-400"
                    title="Remove model"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2">
                  <label className="flex items-center gap-1 text-[11px] text-neutral-500">
                    ctx
                    <input
                      type="number"
                      value={model.contextWindow ?? ''}
                      onChange={(e) =>
                        patchModel(pi, mi, {
                          contextWindow: e.target.value === '' ? undefined : Number(e.target.value),
                        })
                      }
                      className="w-full rounded border border-neutral-700 bg-neutral-900 px-1 py-0.5 text-xs text-neutral-200 focus:border-blue-500 focus:outline-none"
                    />
                  </label>
                  <label className="flex items-center gap-1 text-[11px] text-neutral-500">
                    max
                    <input
                      type="number"
                      value={model.maxTokens ?? ''}
                      onChange={(e) =>
                        patchModel(pi, mi, {
                          maxTokens: e.target.value === '' ? undefined : Number(e.target.value),
                        })
                      }
                      className="w-full rounded border border-neutral-700 bg-neutral-900 px-1 py-0.5 text-xs text-neutral-200 focus:border-blue-500 focus:outline-none"
                    />
                  </label>
                  <label className="flex items-center gap-1 text-[11px] text-neutral-500">
                    <input
                      type="checkbox"
                      checked={model.reasoning ?? false}
                      onChange={(e) => patchModel(pi, mi, { reasoning: e.target.checked })}
                      className="accent-blue-500"
                    />
                    reasoning
                  </label>
                </div>
              </div>
            ))}
            <button
              onClick={() => addModel(pi)}
              className="flex items-center gap-1 text-xs text-neutral-400 hover:text-neutral-200"
            >
              <Plus size={12} /> Add model
            </button>
          </div>
        </div>
      ))}

      <button
        onClick={addProvider}
        className="flex items-center gap-1 text-sm text-neutral-400 hover:text-neutral-200"
      >
        <Plus size={14} /> Add provider
      </button>

      {errors.length > 0 && (
        <ul className="space-y-1 text-xs text-red-400">
          {errors.map((e, i) => (
            <li key={i}>• {e}</li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          className="flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-500 transition-colors"
        >
          <Save size={14} />
          Save models.json
        </button>
        {saved && (
          <button
            onClick={() => restartPi()}
            className={clsx(
              'flex items-center gap-2 rounded-md border border-neutral-700 px-3 py-2 text-sm',
              'text-neutral-300 hover:bg-neutral-800 transition-colors'
            )}
          >
            <RefreshCw size={14} />
            Saved — Restart PI to apply
          </button>
        )}
      </div>
    </div>
  )
}
