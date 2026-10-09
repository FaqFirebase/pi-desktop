/**
 * `file://` URLs for local paths, shared by main and renderer. The renderer has
 * no Node `url` module (`pathToFileURL`), so the URL is built here from strings.
 */

const FILE_URL_PREFIX = 'file://'
const URL_PATH_SEPARATOR = '/'
// `\\server\share\…` (or with forward slashes): a Windows UNC path.
const UNC_PREFIX = /^[\\/]{2}/
// `C:\…` or `C:/…`: a Windows drive path. The drive letter stays as is.
const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:(?=[\\/])/
const WINDOWS_SEPARATORS = /[\\/]/
const POSIX_ROOT = /^\//

function encodeSegments(segments: readonly string[]): string {
  return segments.map(encodeURIComponent).join(URL_PATH_SEPARATOR)
}

/**
 * The `file://` URL of an absolute path. Every path segment is percent-encoded,
 * so no character in a name (`#`, `?`, `%`, a space, a non-ASCII letter) can
 * start a query or fragment or otherwise change which file the URL loads.
 *
 * Windows: `C:\a b\x.pdf` -> `file:///C:/a%20b/x.pdf`, and a UNC path names its
 * server as the host (`\\server\share\x.pdf` -> `file://server/share/x.pdf`).
 * POSIX: only `/` separates; a backslash is an ordinary file-name character.
 */
export function toFileUrl(absolutePath: string): string {
  if (UNC_PREFIX.test(absolutePath)) {
    const [host, ...segments] = absolutePath.replace(UNC_PREFIX, '').split(WINDOWS_SEPARATORS)
    return `${FILE_URL_PREFIX}${encodeURIComponent(host)}${URL_PATH_SEPARATOR}${encodeSegments(segments)}`
  }
  const drive = WINDOWS_DRIVE_PREFIX.exec(absolutePath)?.[0]
  if (drive) {
    const segments = absolutePath.slice(drive.length).split(WINDOWS_SEPARATORS)
    return `${FILE_URL_PREFIX}${URL_PATH_SEPARATOR}${drive}${encodeSegments(segments)}`
  }
  // The host stays empty for every non-UNC path, so a path that is not rooted
  // (callers never pass one) cannot name a network share either.
  const segments = absolutePath.replace(POSIX_ROOT, '').split(URL_PATH_SEPARATOR)
  return `${FILE_URL_PREFIX}${URL_PATH_SEPARATOR}${encodeSegments(segments)}`
}
