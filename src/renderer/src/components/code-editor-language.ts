import { cpp } from '@codemirror/lang-cpp'
import { css } from '@codemirror/lang-css'
import { go } from '@codemirror/lang-go'
import { html } from '@codemirror/lang-html'
import { java } from '@codemirror/lang-java'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { php } from '@codemirror/lang-php'
import { python } from '@codemirror/lang-python'
import { rust } from '@codemirror/lang-rust'
import { sql } from '@codemirror/lang-sql'
import { xml } from '@codemirror/lang-xml'
import { yaml } from '@codemirror/lang-yaml'
import type { Extension } from '@codemirror/state'

export function getCodeEditorLanguageName(filePath: string): string {
  const ext = getExtension(filePath)

  if (ext === '.ts' || ext === '.tsx') return 'typescript'
  if (ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') return 'javascript'
  if (ext === '.json') return 'json'
  if (ext === '.md' || ext === '.mdx') return 'markdown'
  if (ext === '.html' || ext === '.htm') return 'html'
  if (ext === '.css' || ext === '.scss' || ext === '.less') return 'css'
  if (ext === '.py') return 'python'
  if (ext === '.rs') return 'rust'
  if (ext === '.go') return 'go'
  if (ext === '.java') return 'java'
  if (ext === '.php') return 'php'
  if (ext === '.xml' || ext === '.svg') return 'xml'
  if (ext === '.sql') return 'sql'
  if (ext === '.yaml' || ext === '.yml') return 'yaml'
  if (ext === '.c' || ext === '.cc' || ext === '.cpp' || ext === '.cxx' || ext === '.h' || ext === '.hpp' || ext === '.cs') return 'cpp'

  return 'plain text'
}

export function getCodeEditorLanguageExtensions(filePath: string): Extension[] {
  const language = getCodeEditorLanguageName(filePath)

  switch (language) {
    case 'typescript':
      return [javascript({ typescript: true, jsx: filePath.toLowerCase().endsWith('.tsx') })]
    case 'javascript':
      return [javascript({ jsx: filePath.toLowerCase().endsWith('.jsx') })]
    case 'json':
      return [json()]
    case 'markdown':
      // markdownLanguage = GitHub-flavored Markdown: enables tables,
      // strikethrough, task lists, and autolinks so they get tokenized
      // and colored. The default markdown() is plain CommonMark which
      // leaves table syntax as undecorated plain text.
      return [markdown({ base: markdownLanguage })]
    case 'html':
      return [html()]
    case 'css':
      return [css()]
    case 'python':
      return [python()]
    case 'rust':
      return [rust()]
    case 'go':
      return [go()]
    case 'java':
      return [java()]
    case 'php':
      return [php()]
    case 'xml':
      return [xml()]
    case 'sql':
      return [sql()]
    case 'yaml':
      return [yaml()]
    case 'cpp':
      return [cpp()]
    default:
      return []
  }
}

function getExtension(filePath: string): string {
  const cleanPath = filePath.split(/[?#]/, 1)[0].toLowerCase()
  const slashIndex = cleanPath.lastIndexOf('/')
  const fileName = slashIndex >= 0 ? cleanPath.slice(slashIndex + 1) : cleanPath
  const dotIndex = fileName.lastIndexOf('.')
  return dotIndex >= 0 ? fileName.slice(dotIndex) : ''
}
