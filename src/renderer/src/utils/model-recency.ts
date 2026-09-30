const MODEL_RECENCY_STORAGE_KEY = 'pi-desktop.model-recency'

/** `provider/id` -> last time the user picked that model (ms since epoch). */
export type ModelRecency = Record<string, number>

export function modelRecencyKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`
}

export function readModelRecency(): ModelRecency {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(MODEL_RECENCY_STORAGE_KEY) ?? '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
    )
  } catch {
    // An unreadable store only loses the ordering, never the picker.
    return {}
  }
}

export function recordModelUse(model: { provider: string; id: string }, now = Date.now()): ModelRecency {
  const recency = { ...readModelRecency(), [modelRecencyKey(model)]: now }
  try {
    localStorage.setItem(MODEL_RECENCY_STORAGE_KEY, JSON.stringify(recency))
  } catch {
    // The pick still applies when storage is unavailable.
  }
  return recency
}
