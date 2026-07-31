/**
 * Escaping for Windows spawns that must run with shell:true.
 *
 * Since Node's CVE-2024-27980 fix, `.cmd`/`.bat` shims can only be launched
 * through cmd.exe (shell:true) — and with shell:true Node performs NO quoting:
 * it joins program and args with spaces into `cmd.exe /d /s /c "..."`. Every
 * argument therefore traverses up to three parsers, and must survive each:
 *
 *   1. cmd.exe's command line: phase 1 expands %var% (even inside quotes),
 *      phase 2 honors quotes and treats & | < > ^ ( ) as operators outside
 *      them. `cmd /c` uses command-line semantics: an UNDEFINED %name%
 *      reference is left literal (in batch files it would collapse to
 *      nothing), and carets are consumed outside quotes.
 *   2. The `.cmd` shim's own `%*` line: npm shims re-insert the args into a
 *      batch line (`"%_prog%" "%dp0%\...\cli.js" %*`) that goes through cmd's
 *      phase 2 AGAIN. `%*` substitution is single-pass and non-recursive, so
 *      percents inside argument text are not re-expanded there — but any
 *      metacharacter not enclosed in REAL quotes at this point injects (the
 *      BatBadBut pattern, CVE-2024-24576).
 *   3. The final program's argv split (CommandLineToArgvW / CRT rules):
 *      backslashes are literal except runs preceding a quote (2n backslashes
 *      collapse to n), and inside a quoted span a PAIRED `""` yields one
 *      literal quote.
 *
 * Parser 2 is why the classic caret-everything approach (argv-quote with \",
 *  then ^-prefix every metacharacter) is NOT used for arguments: the outer
 * cmd.exe consumes the carets, so by the time the shim's `%*` line re-parses
 * the text, a quote escaped as \" has broken cmd's quote pairing and any
 * following & | < > executes inside the shim. The encoding that survives all
 * three parsers is:
 *
 *   - wrap the argument in real double quotes (kept by every cmd pass, so
 *     metacharacters stay quoted through the shim), escaping embedded quotes
 *     as paired `""` — which preserves cmd's quote parity AND parses back to
 *     one literal quote under rule 3;
 *   - double every backslash run that precedes an emitted quote, per the
 *     Microsoft argv rules of parser 3;
 *   - `%` and `!` expand inside quotes, so each is moved OUTSIDE the quotes
 *     and caret-interrupted: `"^%"` / `"^!"`. The caret lands inside every
 *     candidate variable name, no such name is defined, command-line
 *     semantics keep the undefined reference literal, and phase 2 then strips
 *     the caret — restoring the original character. No whitespace is ever
 *     exposed outside quotes, so the argument cannot split.
 *
 * Known residual limits, unfixable at this layer: an environment variable
 * whose name itself contains a caret would still expand, and delayed expansion
 * can mangle `^`/`!` combinations inside a shim we do not control. Delayed
 * expansion is OFF for `cmd /c` by default, so this affects only two host
 * configurations: a machine whose Command Processor\DelayedExpansion registry
 * value (HKCU or HKLM) is enabled, and a shim that runs `setlocal
 * EnableDelayedExpansion` itself. \r, \n and NUL truncate the command line and
 * have no escape at all, so they are rejected outright.
 *
 * The program token gets its own, different treatment (quoteCmdProgram):
 * cmd.exe locates the command with genuine quote state, so its quotes must be
 * real (a caret-escaped quote would end the token at the first space), and
 * cmd — not the CRT — consumes them, so argv backslash doubling does not
 * apply. What follows depends on who parses the token last:
 *
 *   - `.cmd`/`.bat` shims, and every other target (a bare name cmd resolves
 *     through PATHEXT ends up at one): cmd alone consumes the token, so `%`
 *     and `!` are caret-interrupted exactly as in arguments and nothing
 *     re-reads the text. This is also the safe default for an unknown target,
 *     since an interruption can only be observed by a CRT argv[0] parse.
 *   - `.exe`/`.com` targets: cmd hands the command line to CreateProcess and
 *     the child's CRT re-parses argv[0], where a LEADING quote runs to the
 *     next quote with no escape processing. An interruption would therefore
 *     end argv[0] early and spill the remainder into a spurious argv[1], so
 *     the path is wrapped in plain real quotes instead. Residual risk, of the
 *     same kind as the delayed-expansion caveat above: a defined `%VAR%`
 *     reference inside such a path still expands in cmd's phase 1. Windows
 *     paths containing `%` are pathological, and no encoding can prevent it
 *     while keeping argv[0] intact.
 */

const BACKSLASH = '\\'
const QUOTE = '"'
/** Paired-quote escape: keeps cmd quote parity, parses back to one quote. */
const DOUBLED_QUOTE = '""'
/** Close the quotes, neutralize the character with a caret, reopen. */
const PERCENT_INTERRUPT = '"^%"'
const BANG_INTERRUPT = '"^!"'
/** Characters cmd.exe treats as line terminators; nothing can escape them. */
const CMD_UNPASSABLE_CHARS = ['\0', '\r', '\n']
/** Anything here forces the full quoting algorithm; a miss stays byte-identical. */
const ARG_NEEDS_QUOTING = /[\s"%!^&|<>()]/
/** Same set minus the quote, which is rejected for program paths instead. */
const PROGRAM_NEEDS_QUOTING = /[\s%!^&|<>()]/
/** Targets cmd.exe starts directly, leaving the child's CRT to re-parse argv[0]. */
const NATIVE_PROGRAM_PATTERN = /\.(exe|com)$/i

function assertCmdPassable(value: string, role: string): void {
  for (const char of CMD_UNPASSABLE_CHARS) {
    if (value.includes(char)) {
      throw new Error(
        `${role} contains characters that cannot be passed through cmd.exe: ${JSON.stringify(value)}`,
      )
    }
  }
}

/**
 * Escape one argv element for a Windows shell:true spawn. Safe plain args
 * (flags, bare paths) are returned unchanged.
 */
export function escapeCmdArg(arg: string): string {
  assertCmdPassable(arg, 'argument')
  if (arg !== '' && !ARG_NEEDS_QUOTING.test(arg)) return arg

  let out = QUOTE
  let backslashes = 0
  for (const char of arg) {
    if (char === BACKSLASH) {
      backslashes += 1
      continue
    }
    if (char === QUOTE || char === '%' || char === '!') {
      // Each of these emits a quote next, so the run preceding it doubles.
      out += BACKSLASH.repeat(backslashes * 2)
      out += char === QUOTE ? DOUBLED_QUOTE : char === '%' ? PERCENT_INTERRUPT : BANG_INTERRUPT
    } else {
      out += BACKSLASH.repeat(backslashes) + char
    }
    backslashes = 0
  }
  return out + BACKSLASH.repeat(backslashes * 2) + QUOTE
}

/**
 * Quote the program token of a Windows shell:true spawn. Plain names and
 * paths are returned unchanged; quotes cannot appear in Windows paths and are
 * rejected rather than escaped, because no escape exists in command position.
 * The encoding follows the target type (see the file header): `%`/`!` are
 * caret-interrupted for shims, whose token only cmd itself reads, and left
 * inside plain quotes for native binaries, whose CRT re-parses argv[0].
 */
export function quoteCmdProgram(program: string): string {
  assertCmdPassable(program, 'program')
  if (program.includes(QUOTE)) {
    throw new Error(
      `program contains a quote and cannot be quoted as a cmd.exe program: ${JSON.stringify(program)}`,
    )
  }
  if (program !== '' && !PROGRAM_NEEDS_QUOTING.test(program)) return program
  if (NATIVE_PROGRAM_PATTERN.test(program)) return QUOTE + program + QUOTE
  return (
    QUOTE + program.replaceAll('%', PERCENT_INTERRUPT).replaceAll('!', BANG_INTERRUPT) + QUOTE
  )
}

/**
 * Prepare a program + argv pair for spawn(). With `viaCmd` false (POSIX,
 * shell:false) both pass through untouched, keeping non-Windows spawns
 * byte-for-byte identical; with it true both are escaped to survive the
 * cmd.exe traversal that shell:true implies.
 */
export function escapeCmdSpawn(
  viaCmd: boolean,
  file: string,
  args: readonly string[],
): { file: string; args: string[] } {
  if (!viaCmd) return { file, args: [...args] }
  return { file: quoteCmdProgram(file), args: args.map(escapeCmdArg) }
}

const NPM_WINDOWS_SHIM = 'npm.cmd'
const NPM_POSIX_BINARY = 'npm'
const NPM_PREFIX_ARGS = ['prefix', '-g'] as const

/**
 * The `npm prefix -g` probe used to locate globally installed CLIs. Both
 * callers spawn it with shell:true on Windows to reach npm's `.cmd` shim.
 *
 * Every token is a constant that needs no rewriting, so the escaped and raw
 * forms are byte-identical and no behavioural test can distinguish a caller
 * that uses this helper from one that inlines the strings. Centralising it is
 * what keeps the guarantee: a caller that later needs a variable argument
 * inherits the escaping instead of reinventing an unescaped spawn.
 */
export function buildNpmPrefixCommand(isWindows: boolean): { file: string; args: string[] } {
  return escapeCmdSpawn(
    isWindows,
    isWindows ? NPM_WINDOWS_SHIM : NPM_POSIX_BINARY,
    NPM_PREFIX_ARGS,
  )
}
