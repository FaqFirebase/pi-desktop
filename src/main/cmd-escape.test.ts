import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildNpmPrefixCommand,
  escapeCmdArg,
  escapeCmdSpawn,
  quoteCmdProgram,
} from './cmd-escape'

// --- escapeCmdArg: args that need no rewriting stay byte-identical ---

test('escapeCmdArg leaves plain flags unchanged', () => {
  assert.equal(escapeCmdArg('-p'), '-p')
  assert.equal(escapeCmdArg('--output-format'), '--output-format')
  assert.equal(escapeCmdArg('stream-json'), 'stream-json')
  assert.equal(escapeCmdArg('prefix'), 'prefix')
  assert.equal(escapeCmdArg('-g'), '-g')
})

test('escapeCmdArg leaves a bare windows path without spaces unchanged', () => {
  assert.equal(
    escapeCmdArg(String.raw`C:\Users\tester\file.txt`),
    String.raw`C:\Users\tester\file.txt`,
  )
})

// --- escapeCmdArg: quoting layer (Microsoft argv backslash rules + "" quotes) ---

test('escapeCmdArg quotes an arg containing spaces', () => {
  assert.equal(escapeCmdArg('hello world'), '"hello world"')
})

test('escapeCmdArg quotes an arg containing a tab', () => {
  assert.equal(escapeCmdArg('a\tb'), '"a\tb"')
})

test('escapeCmdArg doubles embedded double quotes', () => {
  assert.equal(escapeCmdArg('say "hi"'), '"say ""hi"""')
})

test('escapeCmdArg escapes a quote even without surrounding spaces', () => {
  assert.equal(escapeCmdArg('a"b'), '"a""b"')
})

test('escapeCmdArg doubles backslashes that precede an embedded quote', () => {
  assert.equal(escapeCmdArg(String.raw`a\"b`), String.raw`"a\\""b"`)
})

test('escapeCmdArg doubles trailing backslashes before the closing quote', () => {
  assert.equal(escapeCmdArg('C:\\my dir\\'), String.raw`"C:\my dir\\"`)
  assert.equal(escapeCmdArg(String.raw`a b\\`), String.raw`"a b\\\\"`)
})

test('escapeCmdArg leaves interior backslashes alone', () => {
  assert.equal(escapeCmdArg(String.raw`C:\my dir\file.txt`), String.raw`"C:\my dir\file.txt"`)
})

test('escapeCmdArg quotes the empty string', () => {
  assert.equal(escapeCmdArg(''), '""')
})

// --- escapeCmdArg: cmd.exe metacharacters are enclosed in real quotes ---

test('escapeCmdArg encloses ampersand command chaining in quotes', () => {
  assert.equal(escapeCmdArg('a&b'), '"a&b"')
  assert.equal(escapeCmdArg('a&&calc'), '"a&&calc"')
})

test('escapeCmdArg encloses pipes in quotes', () => {
  assert.equal(escapeCmdArg('a|b'), '"a|b"')
})

test('escapeCmdArg encloses carets in quotes', () => {
  assert.equal(escapeCmdArg('a^b'), '"a^b"')
})

test('escapeCmdArg encloses redirects in quotes', () => {
  assert.equal(escapeCmdArg('a<in>out'), '"a<in>out"')
})

test('escapeCmdArg encloses parentheses in quotes', () => {
  assert.equal(escapeCmdArg('(paren)'), '"(paren)"')
})

// --- escapeCmdArg: % and ! expand even inside quotes, so they are interrupted ---

test('escapeCmdArg interrupts %VAR% outside the quotes with a caret', () => {
  assert.equal(escapeCmdArg('%PATH%'), '""^%"PATH"^%""')
  assert.equal(escapeCmdArg('100%'), '"100"^%""')
})

test('escapeCmdArg interrupts delayed-expansion bangs outside the quotes', () => {
  assert.equal(escapeCmdArg('!delayed!'), '""^!"delayed"^!""')
})

test('escapeCmdArg doubles backslashes that precede a percent interrupt', () => {
  // The interrupt opens with a quote, so a preceding backslash run must be
  // doubled exactly as it would be before any other emitted quote.
  assert.equal(escapeCmdArg(String.raw`dir\%PATH%`), String.raw`"dir\\"^%"PATH"^%""`)
})

test('escapeCmdArg handles a realistic council prompt full of metacharacters', () => {
  const prompt = 'Fix build & deploy | grep "error" > out.txt (100% done)'
  assert.equal(
    escapeCmdArg(prompt),
    '"Fix build & deploy | grep ""error"" > out.txt (100"^%" done)"',
  )
})

// --- escapeCmdArg: characters no escaping can make safe ---

test('escapeCmdArg rejects newlines, carriage returns, and NUL', () => {
  assert.throws(() => escapeCmdArg('a\nb'), /cannot be passed through cmd\.exe/)
  assert.throws(() => escapeCmdArg('a\rb'), /cannot be passed through cmd\.exe/)
  assert.throws(() => escapeCmdArg('a\0b'), /cannot be passed through cmd\.exe/)
})

// --- quoteCmdProgram ---

test('quoteCmdProgram leaves a bare shim name unchanged', () => {
  assert.equal(quoteCmdProgram('npm.cmd'), 'npm.cmd')
})

test('quoteCmdProgram leaves a plain absolute path unchanged', () => {
  assert.equal(
    quoteCmdProgram(String.raw`C:\Users\tester\AppData\Roaming\npm\claude.cmd`),
    String.raw`C:\Users\tester\AppData\Roaming\npm\claude.cmd`,
  )
})

test('quoteCmdProgram quotes a path containing spaces', () => {
  assert.equal(
    quoteCmdProgram(String.raw`C:\Program Files\nodejs\claude.cmd`),
    String.raw`"C:\Program Files\nodejs\claude.cmd"`,
  )
})

test('quoteCmdProgram quotes a path containing an ampersand', () => {
  assert.equal(
    quoteCmdProgram(String.raw`C:\Users\Tom & Jerry\npm\pi.cmd`),
    String.raw`"C:\Users\Tom & Jerry\npm\pi.cmd"`,
  )
})

test('quoteCmdProgram quotes a path containing a caret', () => {
  assert.equal(quoteCmdProgram(String.raw`C:\odd^dir\pi.cmd`), String.raw`"C:\odd^dir\pi.cmd"`)
})

test('quoteCmdProgram interrupts percent signs outside the quotes for a shim target', () => {
  assert.equal(
    quoteCmdProgram(String.raw`C:\Users\100%cool\pi.cmd`),
    String.raw`"C:\Users\100"^%"cool\pi.cmd"`,
  )
  assert.equal(quoteCmdProgram(String.raw`C:\a%b%c\pi.cmd`), String.raw`"C:\a"^%"b"^%"c\pi.cmd"`)
})

test('quoteCmdProgram interrupts exclamation marks outside the quotes for a shim target', () => {
  assert.equal(
    quoteCmdProgram(String.raw`C:\Users\wow!\pi.cmd`),
    String.raw`"C:\Users\wow"^!"\pi.cmd"`,
  )
  assert.equal(quoteCmdProgram(String.raw`C:\a!b!c\pi.bat`), String.raw`"C:\a"^!"b"^!"c\pi.bat"`)
})

test('quoteCmdProgram uses plain quotes for a native executable target', () => {
  // cmd hands the token to the child verbatim; an interruption would end the
  // CRT's argv[0] at the first quote and spill the remainder into argv[1].
  assert.equal(
    quoteCmdProgram(String.raw`C:\Users\100%cool\pi.exe`),
    String.raw`"C:\Users\100%cool\pi.exe"`,
  )
  assert.equal(quoteCmdProgram(String.raw`C:\Users\wow!\pi.EXE`), String.raw`"C:\Users\wow!\pi.EXE"`)
  assert.equal(quoteCmdProgram(String.raw`C:\odd dir\pi.com`), String.raw`"C:\odd dir\pi.com"`)
})

test('quoteCmdProgram rejects embedded quotes and control characters', () => {
  assert.throws(() => quoteCmdProgram('bad"name.cmd'), /cannot be quoted as a cmd\.exe program/)
  assert.throws(() => quoteCmdProgram('bad\nname.cmd'), /cannot be passed through cmd\.exe/)
})

// --- quoteCmdProgram: end-to-end round trip through the parsers it must survive ---

const CARET = '^'
const QUOTE_CHAR = '"'
const BACKSLASH_CHAR = '\\'
/** Extensions cmd.exe launches through CreateProcess, leaving the CRT to re-parse argv[0]. */
const NATIVE_TARGET = /\.(exe|com)$/i
/** Fake host environment for the expansion phase; `b` proves the interruption works. */
const HOST_ENV: Record<string, string> = { b: 'EXPANDED', PATH: 'C:\\Windows' }

/** What the child process ends up seeing for the program token. */
interface ChildCommand {
  program: string
  extraArgs: string[]
}

/**
 * cmd.exe phase 1: substitute %name% pairs, quotes included. `cmd /c` keeps an
 * undefined reference literal instead of collapsing it, so a name our escaping
 * interrupted with a caret survives untouched.
 */
function expandPercentRefs(line: string, env: Record<string, string>): string {
  let out = ''
  for (let index = 0; index < line.length; index++) {
    if (line[index] !== '%') {
      out += line[index]
      continue
    }
    const close = line.indexOf('%', index + 1)
    const value = close === -1 ? undefined : env[line.slice(index + 1, close)]
    if (value === undefined) {
      out += line[index]
      continue
    }
    out += value
    index = close
  }
  return out
}

/** cmd.exe phase 2: a caret outside quotes escapes the next character and vanishes. */
function consumeCarets(line: string): string {
  let out = ''
  let inQuotes = false
  for (let index = 0; index < line.length; index++) {
    const char = line[index]
    if (!inQuotes && char === CARET && index + 1 < line.length) {
      out += line[index + 1]
      index++
      continue
    }
    if (char === QUOTE_CHAR) inQuotes = !inQuotes
    out += char
  }
  return out
}

/** Split on whitespace that is not inside a quoted span, then drop the real quotes. */
function splitUnquotedFields(line: string): string[] {
  const fields: string[] = []
  let current = ''
  let started = false
  let inQuotes = false
  for (const char of line) {
    if (char === QUOTE_CHAR) {
      inQuotes = !inQuotes
      started = true
      continue
    }
    if (!inQuotes && /\s/.test(char)) {
      if (started) fields.push(current)
      current = ''
      started = false
      continue
    }
    current += char
    started = true
  }
  if (started) fields.push(current)
  return fields
}

/**
 * The CRT / CommandLineToArgvW split, including the argv[0] special case: a
 * leading quote makes argv[0] run to the NEXT quote with no escape processing,
 * which is exactly what a program-token interruption breaks.
 */
function crtArgv(line: string): string[] {
  const argv: string[] = []
  let index = 0
  if (line[0] === QUOTE_CHAR) {
    const close = line.indexOf(QUOTE_CHAR, 1)
    argv.push(line.slice(1, close === -1 ? line.length : close))
    index = close === -1 ? line.length : close + 1
  } else {
    while (index < line.length && !/\s/.test(line[index])) index++
    argv.push(line.slice(0, index))
  }

  let current = ''
  let started = false
  let inQuotes = false
  let backslashes = 0
  for (; index < line.length; index++) {
    const char = line[index]
    if (char === BACKSLASH_CHAR) {
      backslashes++
      continue
    }
    if (char === QUOTE_CHAR) {
      current += BACKSLASH_CHAR.repeat(Math.floor(backslashes / 2))
      const escaped = backslashes % 2 === 1
      backslashes = 0
      started = true
      if (escaped) {
        current += QUOTE_CHAR
      } else if (inQuotes && line[index + 1] === QUOTE_CHAR) {
        current += QUOTE_CHAR
        index++
      } else {
        inQuotes = !inQuotes
      }
      continue
    }
    current += BACKSLASH_CHAR.repeat(backslashes)
    backslashes = 0
    if (!inQuotes && /\s/.test(char)) {
      if (started) argv.push(current)
      current = ''
      started = false
      continue
    }
    current += char
    started = true
  }
  current += BACKSLASH_CHAR.repeat(backslashes)
  if (started || current !== '') argv.push(current)
  return argv
}

/**
 * Push a program path through the whole Windows chain: our escaping, cmd.exe's
 * two phases, and then whichever token parse the target type implies — cmd
 * consuming the token for a shim, the CRT re-parsing it for a native binary.
 */
function throughCmd(program: string, env: Record<string, string> = HOST_ENV): ChildCommand {
  const line = consumeCarets(expandPercentRefs(quoteCmdProgram(program), env))
  const argv = NATIVE_TARGET.test(program) ? crtArgv(line) : splitUnquotedFields(line)
  return { program: argv[0], extraArgs: argv.slice(1) }
}

const ROUND_TRIP_PATHS = [
  String.raw`C:\Users\tester\npm\pi`,
  String.raw`C:\Program Files\nodejs\pi`,
  String.raw`C:\Users\100%cool\pi`,
  String.raw`C:\Users\wow!\pi`,
  String.raw`C:\Users\Tom & Jerry\100%!\pi`,
  String.raw`C:\odd^dir (x86)\a b\pi`,
]

test('quoteCmdProgram round-trips shim paths through cmd.exe untouched', () => {
  for (const base of ROUND_TRIP_PATHS) {
    const path = `${base}.cmd`
    assert.deepEqual(throughCmd(path), { program: path, extraArgs: [] }, path)
  }
})

test('quoteCmdProgram round-trips native executable paths through cmd.exe untouched', () => {
  for (const base of ROUND_TRIP_PATHS) {
    const path = `${base}.exe`
    assert.deepEqual(throughCmd(path), { program: path, extraArgs: [] }, path)
  }
})

test('quoteCmdProgram keeps a defined %VAR% literal in a shim path', () => {
  const path = String.raw`C:\a%b%c\pi.cmd`
  assert.deepEqual(throughCmd(path), { program: path, extraArgs: [] })
})

test('quoteCmdProgram cannot stop %VAR% expansion in a native executable path', () => {
  // Documented residual: the CRT argv[0] rule forbids the caret interruption
  // for native targets, so a defined variable reference in the path still
  // expands. Pinned so the trade-off cannot be lost silently.
  assert.deepEqual(throughCmd(String.raw`C:\a%b%c\pi.exe`), {
    program: String.raw`C:\aEXPANDEDc\pi.exe`,
    extraArgs: [],
  })
})

// --- escapeCmdSpawn ---

test('escapeCmdSpawn passes program and args through untouched off the cmd path', () => {
  assert.deepEqual(escapeCmdSpawn(false, '/usr/bin/claude', ['-p', 'a b', 'x&y']), {
    file: '/usr/bin/claude',
    args: ['-p', 'a b', 'x&y'],
  })
})

test('escapeCmdSpawn keeps the npm prefix probe byte-identical on the cmd path', () => {
  assert.deepEqual(escapeCmdSpawn(true, 'npm.cmd', ['prefix', '-g']), {
    file: 'npm.cmd',
    args: ['prefix', '-g'],
  })
})

test('escapeCmdSpawn quotes the program and escapes each arg on the cmd path', () => {
  assert.deepEqual(
    escapeCmdSpawn(true, String.raw`C:\Program Files\nodejs\claude.cmd`, ['-p', 'a b', 'x&y']),
    {
      file: String.raw`"C:\Program Files\nodejs\claude.cmd"`,
      args: ['-p', '"a b"', '"x&y"'],
    },
  )
})

test('escapeCmdSpawn does not mutate the input args array', () => {
  const args = ['a b']
  escapeCmdSpawn(true, 'npm.cmd', args)
  assert.deepEqual(args, ['a b'])
})

// --- buildNpmPrefixCommand: the shared `npm prefix -g` probe ---

test('buildNpmPrefixCommand targets the npm shim through cmd.exe on Windows', () => {
  assert.deepEqual(buildNpmPrefixCommand(true), {
    file: 'npm.cmd',
    args: ['prefix', '-g'],
  })
})

test('buildNpmPrefixCommand targets plain npm off Windows', () => {
  assert.deepEqual(buildNpmPrefixCommand(false), {
    file: 'npm',
    args: ['prefix', '-g'],
  })
})

test('buildNpmPrefixCommand returns a fresh args array each call', () => {
  // Callers hand these straight to spawn; a shared array could be mutated by one
  // caller and observed by the next.
  const first = buildNpmPrefixCommand(true)
  first.args.push('--extra')
  assert.deepEqual(buildNpmPrefixCommand(true).args, ['prefix', '-g'])
})
