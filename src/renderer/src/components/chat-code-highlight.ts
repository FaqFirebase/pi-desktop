import { StreamLanguage, type Language, type StreamParser } from '@codemirror/language'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { python } from '@codemirror/lang-python'
import { rust } from '@codemirror/lang-rust'
import { go } from '@codemirror/lang-go'
import { java } from '@codemirror/lang-java'
import { php } from '@codemirror/lang-php'
import { cpp } from '@codemirror/lang-cpp'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { xml } from '@codemirror/lang-xml'
import { sql } from '@codemirror/lang-sql'
import { yaml } from '@codemirror/lang-yaml'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
// Stream-based (legacy) modes — no Lezer grammar, but tokenize well enough to
// color strings/numbers/comments/keywords with the same themed style.
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { c as clikeC, kotlin, scala, dart, objectiveC } from '@codemirror/legacy-modes/mode/clike'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile'
import { powerShell } from '@codemirror/legacy-modes/mode/powershell'
import { lua } from '@codemirror/legacy-modes/mode/lua'
import { swift } from '@codemirror/legacy-modes/mode/swift'
import { perl } from '@codemirror/legacy-modes/mode/perl'
import { ruby } from '@codemirror/legacy-modes/mode/ruby'
import { r } from '@codemirror/legacy-modes/mode/r'
import { diff } from '@codemirror/legacy-modes/mode/diff'
import { properties } from '@codemirror/legacy-modes/mode/properties'
import { nginx } from '@codemirror/legacy-modes/mode/nginx'
import { clojure } from '@codemirror/legacy-modes/mode/clojure'
import { haskell } from '@codemirror/legacy-modes/mode/haskell'
import { erlang } from '@codemirror/legacy-modes/mode/erlang'
import { groovy } from '@codemirror/legacy-modes/mode/groovy'
import { cmake } from '@codemirror/legacy-modes/mode/cmake'
import { julia } from '@codemirror/legacy-modes/mode/julia'
import { fSharp, oCaml } from '@codemirror/legacy-modes/mode/mllike'
import { pascal } from '@codemirror/legacy-modes/mode/pascal'
import { fortran } from '@codemirror/legacy-modes/mode/fortran'
import { verilog } from '@codemirror/legacy-modes/mode/verilog'
import { vhdl } from '@codemirror/legacy-modes/mode/vhdl'
import { scheme } from '@codemirror/legacy-modes/mode/scheme'
import { commonLisp } from '@codemirror/legacy-modes/mode/commonlisp'
import { tcl } from '@codemirror/legacy-modes/mode/tcl'
import { protobuf } from '@codemirror/legacy-modes/mode/protobuf'
import { coffeeScript } from '@codemirror/legacy-modes/mode/coffeescript'
import { highlightCode } from '@lezer/highlight'
import { StyleModule } from 'style-mod'
import { themedHighlightStyle } from './code-editor-highlight'

// Chat code blocks reuse the exact CodeMirror highlighter the code editor uses
// (themedHighlightStyle over the same Lezer parsers), so colors match 1:1 and
// track the active theme. We render statically with highlightCode instead of
// spinning up an EditorView per block — lighter and safe during streaming.

type LangFactory = () => Language

// Wrap a legacy StreamParser mode as a Language factory.
const stream = (parser: StreamParser<unknown>): LangFactory => () => StreamLanguage.define(parser)

// Map fence language tokens (```<token>) to a CodeMirror Language. Aliases are
// spelled out so the tokens models actually emit resolve. Lezer grammars are
// preferred where available; StreamLanguage (legacy modes) fills the long tail.
const LANGUAGE_FACTORIES: Record<string, LangFactory> = {
  // ── Lezer grammars ──
  javascript: () => javascript().language,
  js: () => javascript().language,
  mjs: () => javascript().language,
  cjs: () => javascript().language,
  jsx: () => javascript({ jsx: true }).language,
  typescript: () => javascript({ typescript: true }).language,
  ts: () => javascript({ typescript: true }).language,
  tsx: () => javascript({ typescript: true, jsx: true }).language,
  json: () => json().language,
  jsonc: () => json().language,
  json5: () => json().language,
  python: () => python().language,
  py: () => python().language,
  rust: () => rust().language,
  rs: () => rust().language,
  go: () => go().language,
  golang: () => go().language,
  java: () => java().language,
  php: () => php().language,
  c: () => cpp().language,
  cpp: () => cpp().language,
  'c++': () => cpp().language,
  cc: () => cpp().language,
  h: () => cpp().language,
  hpp: () => cpp().language,
  cs: () => cpp().language,
  csharp: () => cpp().language,
  css: () => css().language,
  scss: () => css().language,
  less: () => css().language,
  html: () => html().language,
  htm: () => html().language,
  vue: () => html().language,
  svelte: () => html().language,
  xml: () => xml().language,
  svg: () => xml().language,
  sql: () => sql().language,
  yaml: () => yaml().language,
  yml: () => yaml().language,
  markdown: () => markdown({ base: markdownLanguage }).language,
  md: () => markdown({ base: markdownLanguage }).language,

  // ── Legacy stream modes ──
  bash: stream(shell),
  sh: stream(shell),
  shell: stream(shell),
  zsh: stream(shell),
  console: stream(shell),
  kotlin: stream(kotlin),
  kt: stream(kotlin),
  kts: stream(kotlin),
  scala: stream(scala),
  sc: stream(scala),
  dart: stream(dart),
  objectivec: stream(objectiveC),
  objc: stream(objectiveC),
  toml: stream(toml),
  dockerfile: stream(dockerFile),
  docker: stream(dockerFile),
  powershell: stream(powerShell),
  ps1: stream(powerShell),
  ps: stream(powerShell),
  lua: stream(lua),
  swift: stream(swift),
  perl: stream(perl),
  pl: stream(perl),
  ruby: stream(ruby),
  rb: stream(ruby),
  r: stream(r),
  diff: stream(diff),
  patch: stream(diff),
  ini: stream(properties),
  properties: stream(properties),
  conf: stream(properties),
  nginx: stream(nginx),
  clojure: stream(clojure),
  clj: stream(clojure),
  cljs: stream(clojure),
  edn: stream(clojure),
  haskell: stream(haskell),
  hs: stream(haskell),
  erlang: stream(erlang),
  erl: stream(erlang),
  groovy: stream(groovy),
  gradle: stream(groovy),
  cmake: stream(cmake),
  julia: stream(julia),
  jl: stream(julia),
  fsharp: stream(fSharp),
  fs: stream(fSharp),
  ocaml: stream(oCaml),
  ml: stream(oCaml),
  pascal: stream(pascal),
  pas: stream(pascal),
  fortran: stream(fortran),
  f90: stream(fortran),
  verilog: stream(verilog),
  sv: stream(verilog),
  vhdl: stream(vhdl),
  scheme: stream(scheme),
  scm: stream(scheme),
  lisp: stream(commonLisp),
  commonlisp: stream(commonLisp),
  tcl: stream(tcl),
  protobuf: stream(protobuf),
  proto: stream(protobuf),
  coffeescript: stream(coffeeScript),
  coffee: stream(coffeeScript),
  // LSL has no dedicated grammar; it is C-like, so the generic clike tokenizer
  // colors its strings/numbers/comments/braces (but not LSL-specific keywords).
  lsl: stream(clikeC),
}

// Resolved Language instances are cached — parser construction is not free and
// the same few languages recur across a conversation.
const languageCache = new Map<string, Language | null>()

function getLanguage(lang: string): Language | null {
  const key = lang.trim().toLowerCase()
  if (!key) return null
  if (languageCache.has(key)) return languageCache.get(key) ?? null
  const factory = LANGUAGE_FACTORIES[key]
  const language = factory ? factory() : null
  languageCache.set(key, language)
  return language
}

// The HighlightStyle generates its own CSS classes (e.g. `.ͼ1`) whose rules live
// in a StyleModule. Inside an EditorView that module is auto-mounted; standalone
// we must mount it ourselves once so the emitted spans actually get colored.
let stylesMounted = false

function ensureStylesMounted(): void {
  if (stylesMounted) return
  if (themedHighlightStyle.module) {
    StyleModule.mount(document, themedHighlightStyle.module)
  }
  stylesMounted = true
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Highlight `code` for the given fence language token, returning an HTML string
 * of `<span class="…">` runs (for dangerouslySetInnerHTML). Returns null when no
 * parser is available for the language, so callers can fall back to plain text.
 */
export function highlightCodeToHtml(code: string, lang: string): string | null {
  const language = getLanguage(lang)
  if (!language) return null

  ensureStylesMounted()

  const tree = language.parser.parse(code)
  let html = ''
  highlightCode(
    code,
    tree,
    themedHighlightStyle,
    (text, classes) => {
      const escaped = escapeHtml(text)
      html += classes ? `<span class="${classes}">${escaped}</span>` : escaped
    },
    () => {
      html += '\n'
    }
  )
  return html
}
