export interface CustomModelCost {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface ModelCompat {
  supportsReasoningEffort?: boolean
  supportsDeveloperRole?: boolean
  supportsUsageInStreaming?: boolean
  [key: string]: unknown
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
  compat?: ModelCompat
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
  return normalizeModelsConfigForPi(result)
}

export function normalizeModelsConfigForPi(config: ModelsConfig): ModelsConfig {
  const providers: ModelsConfig['providers'] = {}
  let changed = false

  for (const [key, provider] of Object.entries(config.providers ?? {})) {
    let nextProvider = provider

    if (shouldEnableOllamaCloudReasoningEffort(provider)) {
      nextProvider = {
        ...nextProvider,
        compat: {
          ...(nextProvider.compat ?? {}),
          supportsReasoningEffort: true,
        },
      }
      changed = true
    }

    providers[key] = nextProvider
  }

  return changed ? { ...config, providers } : config
}

function isOllamaCloudProvider(provider: ProviderConfig): boolean {
  const baseUrl = provider.baseUrl?.replace(/\/+$/, '')
  return (baseUrl === 'https://ollama.com' || baseUrl === 'https://ollama.com/v1') && provider.api === 'openai-completions'
}

function shouldEnableOllamaCloudReasoningEffort(provider: ProviderConfig): boolean {
  if (!isOllamaCloudProvider(provider)) return false
  if (provider.compat?.supportsReasoningEffort === true) return false
  return (provider.models ?? []).some((model) => model.reasoning === true)
}

const TEXT_INPUT = 'text'
const IMAGE_INPUT = 'image'

/**
 * Toggle image (vision) support in a model's `input` modalities while always
 * keeping text. Returns a new array; never mutates the input.
 */
export function withImageInput(input: string[] | undefined, enabled: boolean): string[] {
  const base = input && input.length > 0 ? input : [TEXT_INPUT]
  const withText = base.includes(TEXT_INPUT) ? base : [TEXT_INPUT, ...base]
  if (enabled) {
    return withText.includes(IMAGE_INPUT) ? [...withText] : [...withText, IMAGE_INPUT]
  }
  return withText.filter((modality) => modality !== IMAGE_INPUT)
}

/**
 * Resolve a model id to its display name from a models config, scanning every
 * provider's models. Returns the raw id when the config is missing or has no
 * matching model with a name (the caller's fallback).
 */
export function modelDisplayName(modelId: string, config: ModelsConfig | null): string {
  if (!modelId || !config) return modelId
  for (const provider of Object.values(config.providers ?? {})) {
    for (const model of provider.models ?? []) {
      if (model.id === modelId && typeof model.name === 'string' && model.name.trim().length > 0) {
        return model.name
      }
    }
  }
  return modelId
}
