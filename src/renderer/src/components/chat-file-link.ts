import { useAppStore } from '../store'

// Image extensions the viewer can render. png/jpg/jpeg/gif/webp arrive as base64
// from readAttachment; svg comes back as text and is rendered from its markup.
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'])

// Common file extensions we treat as "this inline code is a filename". Kept as an
// allowlist (rather than "anything with a dot") so abbreviations like `e.g` and
// version strings like `1.2.3` don't masquerade as clickable files.
const FILE_EXTENSIONS = new Set([
  'txt', 'md', 'mdx', 'rst', 'log', 'csv', 'tsv',
  'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'env', 'properties',
  'xml', 'svg', 'html', 'htm', 'css', 'scss', 'less', 'vue', 'svelte',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'json5',
  'py', 'pyi', 'rb', 'php', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'swift', 'dart',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'cs', 'm', 'mm',
  'lua', 'pl', 'pm', 'r', 'jl', 'ex', 'exs', 'erl', 'clj', 'cljs', 'edn', 'hs', 'ml', 'fs',
  'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd',
  'sql', 'graphql', 'gql', 'proto', 'tcl', 'gradle', 'groovy',
  'lock', 'gitignore', 'dockerignore', 'editorconfig',
  ...IMAGE_EXTENSIONS,
])

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function isImagePath(name: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(name))
}

// Absolute path (forward-slash normalized): Windows drive (C:/…), UNC (//…),
// or POSIX (/…).
function isAbsolutePath(normalized: string): boolean {
  return /^(?:[A-Za-z]:\/|\/)/.test(normalized)
}

// True when a forward-slash-normalized absolute path lives inside the active
// workspace. Used to keep the preview scoped to the workspace (case-insensitive
// to be forgiving on Windows).
function isInsideWorkspace(normalizedAbsolute: string): boolean {
  const root = useAppStore.getState().activeWorkspace?.path
  if (!root) return false
  const normRoot = root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const p = normalizedAbsolute.toLowerCase()
  return p === normRoot || p.startsWith(normRoot + '/')
}

/**
 * Heuristic: does this inline-code text read like a file reference (relative or
 * absolute)? Requires path-safe characters ending in a known extension, and
 * rejects function calls / quoted literals so keywords stay non-clickable.
 */
export function looksLikeFilePath(text: string): boolean {
  const t = text.trim()
  if (!t || /\s/.test(t)) return false
  // Reject function calls, quoted strings, comparisons, globs, etc. (a lone `:`
  // is allowed so Windows drive letters like `C:\…` still qualify).
  if (/[()"'`=<>|*?{}[\];,!@#$%^&~]/.test(t)) return false
  if (t.includes('://')) return false // URLs
  const match = /^(?:[A-Za-z]:)?[A-Za-z0-9_.\-/\\]+\.([A-Za-z0-9]+)$/.exec(t)
  if (!match) return false
  if (!FILE_EXTENSIONS.has(match[1].toLowerCase())) return false
  // Absolute paths are only clickable when they resolve inside the workspace;
  // relative names resolve via workspace search, so they're always fine.
  const normalized = t.replace(/\\/g, '/')
  if (isAbsolutePath(normalized) && !isInsideWorkspace(normalized)) return false
  return true
}

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
}

/**
 * Open the file referenced by inline-code text. Images open in the image viewer
 * pane; other files open in the code editor. Absolute paths are read directly
 * (may live outside the workspace); relative names are resolved by searching the
 * workspace on basename. No-op if nothing resolves.
 */
export async function openFileFromChat(text: string): Promise<void> {
  const original = text.trim()
  const raw = original.replace(/\\/g, '/').replace(/^\.\//, '')
  const base = raw.split('/').pop() ?? raw
  if (!base) return

  const store = useAppStore.getState()

  try {
    // Absolute path: open it directly rather than searching the workspace.
    // The code editor reads paths inside the workspace; the HTML preview loads
    // via file:// so it works regardless. relativePath is the basename so the
    // header stays readable and language/preview detection still works.
    if (isAbsolutePath(raw)) {
      // Only open absolute paths that live inside the active workspace.
      if (!isInsideWorkspace(raw)) return
      if (store.chatSidePanel === 'diff') store.setChatSidePanel(null)
      store.setSelectedFile(base, original)
      return
    }

    const results = await window.piDesktop.files.search(base)
    if (results.length === 0) return

    const wanted = normalize(raw)
    const match =
      results.find((r) => normalize(r.relativePath) === wanted) ??
      results.find((r) => normalize(r.relativePath).endsWith('/' + wanted)) ??
      results.find((r) => r.name.toLowerCase() === base.toLowerCase()) ??
      results[0]

    if (!match) return

    if (store.chatSidePanel === 'diff') store.setChatSidePanel(null)
    store.setSelectedFile(match.relativePath, match.path)
  } catch {
    // File service unavailable or no active workspace — silently ignore.
  }
}
