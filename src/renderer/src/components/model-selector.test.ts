import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
import { thinkingLevels, stepThinkingLevel } from '../utils/thinking-levels'

const source = ts.createSourceFile(
  'model-selector.tsx',
  readFileSync(new URL('./model-selector.tsx', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX,
)

function handler(name: string, bindings: Record<string, unknown>): (...args: unknown[]) => Promise<void> {
  let expression: string | undefined
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) {
      expression = node.initializer?.getText(source)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(expression)
  const code = ts.transpile(`const handler = ${expression}`, { target: ts.ScriptTarget.ES2022 })
  return new Function(...Object.keys(bindings), `${code}; return handler`)(...Object.values(bindings))
}

test('effort arrows prepare a draft for the highlighted model without changing the runtime', () => {
  const model = { id: 'candidate', provider: 'provider', thinking: { efforts: ['low', 'high'] } }
  let draft: unknown
  const keydown = handler('handleSearchKeyDown', {
    loading: false, piStatus: 'running', highlightedModel: model, displayedEffort: 'low',
    thinkingLevels, stepThinkingLevel,
    setEffortDraft: (value: unknown) => { draft = value },
  })
  keydown({ key: 'ArrowRight', nativeEvent: {}, preventDefault() {}, stopPropagation() {} })
  assert.deepEqual(draft, { model, level: 'high' })
})

test('confirmation awaits model selection before applying the chosen effort and closing', async () => {
  const calls: string[] = []
  let finishModel!: () => void
  const selected = new Promise<void>((resolve) => { finishModel = resolve })
  const select = handler('handleSelect', {
    useAppStore: { getState: () => ({ piStatus: 'running' }) },
    draftFor: () => 'high',
    setModel: async () => { calls.push('model'); await selected },
    setThinkingLevel: async (level: string) => { calls.push(level) },
    recordModelUse: () => ({}), setRecency: () => {}, close: () => { calls.push('close') },
  })
  const pending = select({ provider: 'provider', id: 'candidate' })
  assert.deepEqual(calls, ['model'])
  finishModel()
  await pending
  assert.deepEqual(calls, ['model', 'high', 'close'])
})

test('Escape closes the picker and hands focus back to the composer', () => {
  const calls: unknown[] = []
  const keydown = handler('handleSearchKeyDown', {
    close: () => { calls.push('close') },
    useAppStore: { setState: (patch: unknown) => { calls.push(patch) } },
  })
  let prevented = false
  keydown({ key: 'Escape', nativeEvent: {}, preventDefault() { prevented = true }, stopPropagation() {} })
  assert.equal(prevented, true)
  assert.deepEqual(calls, ['close', { composerFocusRequested: true }])
})
