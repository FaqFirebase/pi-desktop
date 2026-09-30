import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { isImeComposing } from '../utils/ime-composing'

function commitKeyHandler(): string {
  const source = ts.createSourceFile(
    'git-conveyor-actions.tsx',
    readFileSync(new URL('./git-conveyor-actions.tsx', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX,
  )
  let handler: string | undefined
  function visit(node: ts.Node): void {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'textarea') {
      for (const attribute of node.attributes.properties) {
        if (ts.isJsxAttribute(attribute) && attribute.name.getText(source) === 'onKeyDown' &&
            attribute.initializer && ts.isJsxExpression(attribute.initializer)) {
          handler = attribute.initializer.expression?.getText(source)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(handler, 'The commit message must handle keyboard submission')
  return handler
}

for (const scenario of [
  { name: 'Command+Enter submits', key: 'Enter', metaKey: true, submits: true },
  { name: 'Ctrl+Enter submits', key: 'Enter', ctrlKey: true, submits: true },
  { name: 'Enter preserves newlines', key: 'Enter', submits: false },
  { name: 'Shift+Enter preserves newlines', key: 'Enter', shiftKey: true, submits: false },
  { name: 'other keys do not submit', key: 'a', metaKey: true, submits: false },
  { name: 'IME confirmation does not submit', key: 'Enter', metaKey: true, nativeEvent: { isComposing: true }, submits: false },
  { name: 'IME processing does not submit', key: 'Enter', metaKey: true, nativeEvent: { keyCode: 229 }, submits: false },
]) {
  test(`commit message: ${scenario.name}`, () => {
    let submissions = 0
    let prevented = false
    let stopped = false
    const handler = new Function('isImeComposing', `return (${commitKeyHandler()})`)(isImeComposing)
    handler({
      nativeEvent: {},
      ...scenario,
      currentTarget: { form: { requestSubmit: () => { submissions++ } } },
      preventDefault: () => { prevented = true },
      stopPropagation: () => { stopped = true },
    })
    assert.equal(submissions, scenario.submits ? 1 : 0)
    assert.equal(prevented, scenario.submits)
    assert.equal(stopped, scenario.submits)
  })
}

test('the action bar follows the same refresh triggers as the diff list', () => {
  const source = readFileSync(new URL('./git-conveyor-actions.tsx', import.meta.url), 'utf8')
  assert.match(source, /useEffect\(\(\) => subscribeWorktreeRefresh\(refresh, watchDisk\), \[refresh, watchDisk\]\)/)
  const diffViewer = readFileSync(new URL('./diff-viewer.tsx', import.meta.url), 'utf8')
  assert.match(diffViewer, /<GitConveyorActions [^>]*watchDisk=\{visible\}/)
})
