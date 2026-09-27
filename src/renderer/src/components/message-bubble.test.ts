import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
import { isImeComposing } from '../utils/ime-composing'

const source = ts.createSourceFile(
  'message-bubble.tsx',
  readFileSync(new URL('./message-bubble.tsx', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
)

function editKeyHandler(): string {
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
  assert.ok(handler, 'The message editor must handle keyboard submission')
  return handler
}

for (const scenario of [
  { name: 'Enter sends the edit', key: 'Enter', shiftKey: false, nativeEvent: {}, sends: true },
  { name: 'Shift+Enter preserves a newline', key: 'Enter', shiftKey: true, nativeEvent: {}, sends: false },
  { name: 'Other keys do not send', key: 'a', shiftKey: false, nativeEvent: {}, sends: false },
  { name: 'IME confirmation does not send', key: 'Enter', shiftKey: false, nativeEvent: { isComposing: true }, sends: false },
  { name: 'IME processing does not send', key: 'Enter', shiftKey: false, nativeEvent: { keyCode: 229 }, sends: false },
]) {
  test(scenario.name, () => {
    let sends = 0
    let prevented = false
    let stopped = false
    const handler = new Function('isImeComposing', 'onSaveEdit', `return (${editKeyHandler()})`)(
      isImeComposing,
      () => { sends++ },
    )
    handler({
      ...scenario,
      preventDefault: () => { prevented = true },
      stopPropagation: () => { stopped = true },
    })
    assert.equal(sends, scenario.sends ? 1 : 0)
    assert.equal(prevented, scenario.sends)
    assert.equal(stopped, scenario.sends)
  })
}
