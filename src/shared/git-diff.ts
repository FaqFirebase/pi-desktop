/**
 * Git diff parsing for one path model: every path is the raw path of the file
 * from the repository root, whatever characters its name holds. Git quotes
 * unusual names in diff headers the way C quotes strings (`quote_c_style`);
 * this module reads and writes that quoting, so diff paths are the same
 * strings as the paths of `git status --porcelain -z`, which never quotes.
 */

const DIFF_HEADER = 'diff --git '
/** Side prefixes of a diff header, pinned by `gitDiffArgs` whatever diff.noprefix or diff.mnemonicPrefix say. */
export const GIT_DIFF_OLD_SIDE = 'a/'
export const GIT_DIFF_NEW_SIDE = 'b/'
const NAME_SEPARATOR = ' '
const QUOTE = '"'
const BACKSLASH = '\\'
/** Header lines that name both sides of a rename or a copy, without side prefixes. */
const MOVE_HEADERS = [['rename from ', 'rename to '], ['copy from ', 'copy to ']] as const
/** The content of a patch starts at the first of these lines; the lines before it are its header. */
const PATCH_BODY_STARTS = ['--- ', '+++ ', '@@', 'Binary files ', 'GIT binary patch']

/** Bytes Git escapes with a letter instead of octal digits (`quote_c_style`). */
const LETTER_ESCAPES: ReadonlyMap<number, string> = new Map([
  [0x07, 'a'], [0x08, 'b'], [0x09, 't'], [0x0a, 'n'], [0x0b, 'v'], [0x0c, 'f'], [0x0d, 'r'],
  [QUOTE.charCodeAt(0), QUOTE], [BACKSLASH.charCodeAt(0), BACKSLASH],
])
const ESCAPED_BYTES: ReadonlyMap<string, number> = new Map([...LETTER_ESCAPES].map(([byte, letter]) => [letter, byte]))
/** Bytes below this are control characters, which Git always escapes. */
const FIRST_PRINTABLE_BYTE = 0x20
/** DEL and every byte above it are escaped too (the default core.quotePath). */
const DELETE_BYTE = 0x7f
const OCTAL_RADIX = 8
const OCTAL_ESCAPE_LENGTH = 3
/** Git's `unquote_c_style` accepts 0-3 as the first digit, so a value fits one byte. */
const OCTAL_ESCAPE = /^[0-3][0-7]{2}/

/**
 * Git file modes of a symbolic link and of a submodule. A patch that names one
 * on any mode line, `index <old>..<new> <mode>` included (a change that keeps
 * the mode), is never discarded.
 */
const SYMLINK_MODE = '120000'
const SUBMODULE_MODE = '160000'
const LINK_MODES = `(?:${SYMLINK_MODE}|${SUBMODULE_MODE})`
const UNDISCARDABLE_PATCH = new RegExp(
  `^Binary files |^GIT binary patch$|^.*mode ${LINK_MODES}$|^index [\\da-f]+\\.\\.[\\da-f]+ ${LINK_MODES}$`, 'm',
)

/**
 * Settings set with `-c` for every diff this module parses: paths from the
 * repository root (diff.relative), and a blank context line that keeps its
 * leading space (diff.suppressBlankEmpty). A Git version without a setting
 * ignores it, unlike an unknown command-line option.
 */
const PARSED_DIFF_SETTINGS = ['diff.relative=false', 'diff.suppressBlankEmpty=false']
/**
 * Options of the same diffs: no color and no external diff tool, fixed side
 * prefixes, and a `diff --git` patch for every submodule (diff.submodule).
 */
const PARSED_DIFF_OPTIONS = [
  '--no-color', '--no-ext-diff', `--src-prefix=${GIT_DIFF_OLD_SIDE}`, `--dst-prefix=${GIT_DIFF_NEW_SIDE}`, '--submodule=short',
]

/** Arguments of `git diff` with `options`, in the form this module parses whatever the user's Git configuration. */
export function gitDiffArgs(...options: string[]): string[] {
  return [...PARSED_DIFF_SETTINGS.flatMap((setting) => ['-c', setting]), 'diff', ...PARSED_DIFF_OPTIONS, ...options]
}

/**
 * Keep each patch intact, removing only blank separators between files. A
 * combined diff (`diff --cc`) of a conflicted file is dropped instead of being
 * left at the end of the patch before it.
 */
export function splitGitDiff(diff: string): string[] {
  return diff.split(/(?=^diff --(?:git|cc|combined) )/m)
    .filter((patch) => patch.startsWith(DIFF_HEADER))
    .map((patch) => patch.replace(/\n+$/, '') + '\n')
}

/**
 * `path` as Git writes it in a diff header: wrapped in double quotes with
 * C-style escapes when it holds a control character, `"`, `\`, DEL, or a
 * non-ASCII letter (octal UTF-8 bytes, as with the default core.quotePath),
 * else unchanged.
 */
export function quoteGitPath(path: string): string {
  let quoted = ''
  let escaped = false
  for (const byte of new TextEncoder().encode(path)) {
    const letter = LETTER_ESCAPES.get(byte)
    if (letter !== undefined) {
      quoted += BACKSLASH + letter
      escaped = true
    } else if (byte < FIRST_PRINTABLE_BYTE || byte >= DELETE_BYTE) {
      quoted += BACKSLASH + byte.toString(OCTAL_RADIX).padStart(OCTAL_ESCAPE_LENGTH, '0')
      escaped = true
    } else {
      quoted += String.fromCharCode(byte)
    }
  }
  return escaped ? QUOTE + quoted + QUOTE : path
}

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** The UTF-8 text of `bytes`, or null for bytes that are not UTF-8 (a name no exact path can hold). */
function utf8Text(bytes: readonly number[]): string | null {
  try {
    return UTF8.decode(new Uint8Array(bytes))
  } catch (error) {
    if (error instanceof TypeError) return null
    throw error
  }
}

/**
 * Read the C-quoted path that opens at `start`, as Git's `unquote_c_style`
 * does: an octal escape is one raw byte of the UTF-8 name. Null when the text
 * there is not one complete quoted path.
 */
function readQuotedGitPath(text: string, start: number): { path: string; end: number } | null {
  if (text[start] !== QUOTE) return null
  const encoder = new TextEncoder()
  const bytes: number[] = []
  let index = start + 1
  while (index < text.length) {
    const char = text[index]
    if (char === QUOTE) {
      const path = utf8Text(bytes)
      return path === null ? null : { path, end: index + 1 }
    }
    if (char !== BACKSLASH) {
      // With core.quotePath=false, non-ASCII letters stay unescaped inside the quotes.
      const literal = String.fromCodePoint(text.codePointAt(index)!)
      bytes.push(...encoder.encode(literal))
      index += literal.length
      continue
    }
    const letterByte = ESCAPED_BYTES.get(text[index + 1])
    if (letterByte !== undefined) {
      bytes.push(letterByte)
      index += 2
      continue
    }
    const octal = OCTAL_ESCAPE.exec(text.slice(index + 1, index + 1 + OCTAL_ESCAPE_LENGTH))
    if (!octal) return null
    bytes.push(parseInt(octal[0], OCTAL_RADIX))
    index += 1 + OCTAL_ESCAPE_LENGTH
  }
  return null
}

/** A path field of a header line: C-quoted when Git escaped it, else the raw path. */
function decodeGitPathField(field: string): string | null {
  if (!field.startsWith(QUOTE)) return field || null
  const quoted = readQuotedGitPath(field, 0)
  return quoted?.end === field.length ? quoted.path : null
}

/**
 * The path both sides of a `diff --git` line name: `"a/X" "b/X"` when Git
 * quoted it, else `a/X b/X`. An unquoted path can hold spaces and even ` b/`,
 * so the only safe split is the one where both halves name the same path.
 */
function sameSidePath(names: string): string | null {
  let oldSide: string
  let newSide: string
  if (names.startsWith(QUOTE)) {
    const old = readQuotedGitPath(names, 0)
    if (!old || names[old.end] !== NAME_SEPARATOR) return null
    const next = readQuotedGitPath(names, old.end + NAME_SEPARATOR.length)
    if (next?.end !== names.length) return null
    oldSide = old.path
    newSide = next.path
  } else {
    const middle = (names.length - NAME_SEPARATOR.length) / 2
    if (!Number.isInteger(middle) || names[middle] !== NAME_SEPARATOR) return null
    oldSide = names.slice(0, middle)
    newSide = names.slice(middle + NAME_SEPARATOR.length)
  }
  if (!oldSide.startsWith(GIT_DIFF_OLD_SIDE) || !newSide.startsWith(GIT_DIFF_NEW_SIDE)) return null
  const path = oldSide.slice(GIT_DIFF_OLD_SIDE.length)
  return path && path === newSide.slice(GIT_DIFF_NEW_SIDE.length) ? path : null
}

export interface GitDiffPaths {
  oldPath: string
  newPath: string
}

/**
 * The repository-root paths of one patch from `splitGitDiff`. A rename or a
 * copy names its two paths on their own header lines; any other patch names
 * one path twice on its `diff --git` line. Null when a name cannot be read
 * exactly (it is not UTF-8, or the header is malformed): such a path is not
 * safe to act on.
 */
export function gitDiffPaths(patch: string): GitDiffPaths | null {
  const lines = patch.split('\n')
  if (!lines[0].startsWith(DIFF_HEADER)) return null
  const bodyStart = lines.findIndex((line, index) => index > 0 && PATCH_BODY_STARTS.some((start) => line.startsWith(start)))
  const header = lines.slice(1, bodyStart === -1 ? lines.length : bodyStart)
  for (const [fromLabel, toLabel] of MOVE_HEADERS) {
    const from = header.find((line) => line.startsWith(fromLabel))
    const to = header.find((line) => line.startsWith(toLabel))
    if (from === undefined && to === undefined) continue
    const oldPath = from === undefined ? null : decodeGitPathField(from.slice(fromLabel.length))
    const newPath = to === undefined ? null : decodeGitPathField(to.slice(toLabel.length))
    return oldPath !== null && newPath !== null ? { oldPath, newPath } : null
  }
  const path = sameSidePath(lines[0].slice(DIFF_HEADER.length))
  return path === null ? null : { oldPath: path, newPath: path }
}

/** The names on a patch's `diff --git` line exactly as Git wrote them, quoting included. */
export function gitDiffHeaderNames(patch: string): string {
  return patch.split('\n', 1)[0].slice(DIFF_HEADER.length)
}

/**
 * Git prints paths from the repository root even when run from a subdirectory.
 * `prefix` is the workspace's own directory inside the repository
 * (`git rev-parse --show-prefix`, '' at the root), so a path outside the
 * workspace comes back with leading `../` segments.
 */
export function workspaceRelativeGitPath(path: string, prefix: string): string {
  if (path.startsWith(prefix)) return path.slice(prefix.length)
  return '../'.repeat(prefix.split('/').filter(Boolean).length) + path
}

/** Text changes to files with readable paths; binary, symlink, and submodule changes are refused. */
export function canDiscardGitPatch(patch: string): boolean {
  return gitDiffPaths(patch) !== null
    && !patch.includes('\0')
    && !UNDISCARDABLE_PATCH.test(patch)
}
