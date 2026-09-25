import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { join, normalize, sep, extname } from 'path'
import { Readable } from 'stream'

// Custom scheme that serves downloaded speech-model files to the renderer under
// the locked CSP. The renderer never reaches the filesystem or the network for
// models; every byte comes through this main-process handler.
export const VOICE_PROTOCOL_SCHEME = 'pi-voice'
const VOICE_PROTOCOL_HOST = 'model'
const NOT_FOUND = 404
const OK = 200

const CONTENT_TYPES: Record<string, string> = {
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.onnx': 'application/octet-stream',
  '.data': 'application/octet-stream',
  '.wasm': 'application/wasm',
}

export function voiceContentType(filePath: string): string {
  return CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Map a `pi-voice://model/<id>/<path>` URL to an absolute path inside the
 * models directory, or null when the URL is malformed, uses the wrong scheme or
 * host, or tries to escape the directory with `..`.
 */
export function resolveVoiceProtocolPath(url: string, modelsDir: string): string | null {
  // The URL parser silently collapses `..`, so screen the raw string first.
  if (/(^|[/\\])\.\.([/\\]|$)/.test(decodeURIComponent(url))) return null

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${VOICE_PROTOCOL_SCHEME}:`) return null
  if (parsed.host !== VOICE_PROTOCOL_HOST) return null

  const rawPath = decodeURIComponent(parsed.pathname).replace(/^[/\\]+/, '')
  if (rawPath.length === 0) return null
  // Refuse any traversal segment before normalization collapses it.
  if (rawPath.split(/[/\\]+/).some((segment) => segment === '..')) return null

  const relative = normalize(rawPath)
  const resolved = join(modelsDir, relative)
  const root = modelsDir.endsWith(sep) ? modelsDir : modelsDir + sep
  if (resolved !== modelsDir && !resolved.startsWith(root)) return null
  return resolved
}

/**
 * Build the HTTP response for a voice-protocol request, streaming the file from
 * the models directory. Returns 404 for a rejected path or a missing file.
 */
export async function handleVoiceProtocolRequest(
  url: string,
  modelsDir: string,
): Promise<Response> {
  const filePath = resolveVoiceProtocolPath(url, modelsDir)
  if (!filePath) return new Response('Not found', { status: NOT_FOUND })
  try {
    const info = await stat(filePath)
    if (!info.isFile()) return new Response('Not found', { status: NOT_FOUND })
    const webStream = Readable.toWeb(createReadStream(filePath)) as unknown as ReadableStream<Uint8Array>
    return new Response(webStream, {
      status: OK,
      headers: {
        'Content-Type': voiceContentType(filePath),
        'Content-Length': String(info.size),
        // The renderer page is a different origin (file:) from this scheme, so
        // the engines' fetches are cross-origin and need this to be allowed.
        'Access-Control-Allow-Origin': '*',
      },
    })
  } catch {
    return new Response('Not found', { status: NOT_FOUND })
  }
}
