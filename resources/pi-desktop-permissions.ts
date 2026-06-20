import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

type PermissionMode = 'ask-edits' | 'ask-commands' | string | undefined

const mode = process.env.PI_DESKTOP_PERMISSION_MODE as PermissionMode

function shouldConfirm(toolName: string): boolean {
  if (mode === 'ask-edits') return toolName === 'edit' || toolName === 'write' || toolName === 'bash'
  if (mode === 'ask-commands') return toolName === 'bash'
  return false
}

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const data = input as Record<string, unknown>
  const path = typeof data.path === 'string' ? data.path : undefined
  const command = typeof data.command === 'string' ? data.command : undefined

  if (path) return `Target: ${path}`
  if (command) return `Command:\n${command}`

  return JSON.stringify(data, null, 2).slice(0, 2000)
}

export default function piDesktopPermissions(pi: ExtensionAPI): void {
  pi.on('tool_call', async (event, ctx) => {
    if (!shouldConfirm(event.toolName)) return

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
