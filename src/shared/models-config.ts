export interface CustomModelCost {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface CustomModel {
  id: string
  name?: string
  api?: string
  reasoning?: boolean
  input?: string[]
  contextWindow?: number
  maxTokens?: number
  cost?: CustomModelCost
  // Preserve fields the editor does not expose (compat, thinkingLevelMap, ...).
  [key: string]: unknown
}

export interface ProviderConfig {
  baseUrl?: string
  api?: string
  apiKey?: string
  models?: CustomModel[]
  // Preserve headers, authHeader, modelOverrides, compat, ...
  [key: string]: unknown
}

export interface ModelsConfig {
  providers: Record<string, ProviderConfig>
  [key: string]: unknown
}

const NUMERIC_MODEL_FIELDS: Array<keyof CustomModel> = ['contextWindow', 'maxTokens']

/**
 * Validate a models config. Returns human-readable error strings; an empty array
 * means valid. Provider keys are inherently unique in the object, so duplicate-key
 * detection belongs to the editor (array) layer.
 */
export function validateModelsConfig(config: ModelsConfig): string[] {
  const errors: string[] = []
  const providers = config.providers ?? {}
  for (const [key, provider] of Object.entries(providers)) {
    if (key.trim().length === 0) {
      errors.push('Provider key must not be empty')
    }
    const models = provider.models ?? []
    const seen = new Set<string>()
    for (const model of models) {
      const id = (model.id ?? '').trim()
      if (id.length === 0) {
        errors.push(`Provider "${key}": a model is missing an id`)
        continue
      }
      if (seen.has(id)) {
        errors.push(`Provider "${key}": duplicate model id "${id}"`)
      }
      seen.add(id)
      for (const field of NUMERIC_MODEL_FIELDS) {
        const value = model[field]
        if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
          errors.push(`Provider "${key}", model "${id}": ${field} must be a finite number`)
        }
      }
    }
  }
  return errors
}

/**
 * Produce the object to write to models.json. Overlays edited known fields onto
 * the original so unknown fields (top-level, per-provider, per-model) are kept.
 * Providers/models absent from `edited` are dropped; new ones are added.
 */
export function mergeModelsConfig(original: ModelsConfig, edited: ModelsConfig): ModelsConfig {
  const result: ModelsConfig = { ...original, providers: {} }
  for (const [key, prov] of Object.entries(edited.providers ?? {})) {
    const origProv = original.providers?.[key] ?? {}
    const origModels = origProv.models ?? []
    const mergedModels = (prov.models ?? []).map((m) => {
      const origModel = origModels.find((o) => o.id === m.id) ?? {}
      return { ...origModel, ...m }
    })
    result.providers[key] = { ...origProv, ...prov, models: mergedModels }
  }
  return result
}
