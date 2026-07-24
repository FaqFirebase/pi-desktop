import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { decideToolCall, loadEffectiveRules } from './permission-rules'

const mode = process.env.PI_DESKTOP_PERMISSION_MODE
const globalRulesPath = process.env.PI_DESKTOP_PERMISSION_RULES_PATH ?? null
// Set by the GUI when spawning Pi for a workspace the user has trusted. Only
// then do this repo's own `allow` rules take effect; otherwise its allow rules
// are ignored and only its deny rules apply (see loadEffectiveRules).
const workspaceTrusted = process.env.PI_DESKTOP_WORKSPACE_TRUSTED === '1'
const MAX_INPUT_SUMMARY_LENGTH = 2000

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const data = input as Record<string, unknown>
  const path = typeof data.path === 'string' ? data.path : undefined
  const command = typeof data.command === 'string' ? data.command : undefined

  if (path) return `Target: ${path}`
  if (command) return `Command:\n${command}`

  return JSON.stringify(data, null, 2).slice(0, MAX_INPUT_SUMMARY_LENGTH)
}

export default function piDesktopPermissions(pi: ExtensionAPI): void {
  pi.on('tool_call', async (event, ctx) => {
    // Rules are re-read per call (mtime-cached), so edits apply without a
    // Pi restart. cwd is the workspace Pi was spawned in.
    const effective = loadEffectiveRules(process.cwd(), globalRulesPath, { workspaceTrusted })
    const decision = decideToolCall(mode, effective.rules, event.toolName, event.input, process.platform)

    if (decision.action === 'block') {
      return { block: true, reason: decision.reason }
    }
    if (decision.action === 'allow') return

    const summary = summarizeInput(event.input)
    const confirmed = await ctx.ui.confirm(
      `Allow ${event.toolName}?`,
      [
        `Pi wants to run the ${event.toolName} tool.`,
        summary,
      ].filter(Boolean).join('\n\n')
    )

    if (!confirmed) {
      return {
        block: true,
        reason: `User denied ${event.toolName} permission in Pi Desktop.`,
      }
    }
  })
}
