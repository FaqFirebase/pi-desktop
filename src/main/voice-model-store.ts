import { mkdir, readFile, writeFile, rm, readdir } from 'fs/promises'
import { join } from 'path'
import { getGuiDataDir } from './app-data-paths'
import type { VoiceModelManifest } from '../shared/voice-models'

export const VOICE_MODELS_DIR_NAME = 'speech-models'
const MANIFEST_FILE_NAME = 'manifest.json'

interface StoreOptions {
  homeDir?: string
  appDataDir?: string
  userDataDir?: string
}

/** Single folder that holds every downloaded speech model. */
export function getVoiceModelsDir(options?: StoreOptions): string {
  return join(getGuiDataDir(options), VOICE_MODELS_DIR_NAME)
}

/** Folder that holds one model's files. */
export function voiceModelDir(id: string, options?: StoreOptions): string {
  return join(getVoiceModelsDir(options), id)
}

function manifestPath(id: string, options?: StoreOptions): string {
  return join(voiceModelDir(id, options), MANIFEST_FILE_NAME)
}

export async function writeVoiceModelManifest(
  manifest: VoiceModelManifest,
  options?: StoreOptions,
): Promise<void> {
  await mkdir(voiceModelDir(manifest.id, options), { recursive: true })
  await writeFile(manifestPath(manifest.id, options), JSON.stringify(manifest, null, 2), 'utf8')
}

export async function readVoiceModelManifest(
  id: string,
  options?: StoreOptions,
): Promise<VoiceModelManifest | null> {
  try {
    const raw = await readFile(manifestPath(id, options), 'utf8')
    const parsed = JSON.parse(raw) as VoiceModelManifest
    if (parsed && typeof parsed.id === 'string' && Array.isArray(parsed.files)) {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

export async function isVoiceModelInstalled(
  id: string,
  options?: StoreOptions,
): Promise<boolean> {
  return (await readVoiceModelManifest(id, options)) !== null
}

export async function listInstalledVoiceModels(
  options?: StoreOptions,
): Promise<VoiceModelManifest[]> {
  let entries: string[]
  try {
    entries = await readdir(getVoiceModelsDir(options))
  } catch {
    return []
  }
  const manifests: VoiceModelManifest[] = []
  for (const entry of entries) {
    const manifest = await readVoiceModelManifest(entry, options)
    if (manifest) {
      manifests.push(manifest)
    }
  }
  return manifests
}

export async function removeVoiceModel(id: string, options?: StoreOptions): Promise<void> {
  await rm(voiceModelDir(id, options), { recursive: true, force: true })
}
