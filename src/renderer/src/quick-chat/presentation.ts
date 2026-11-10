import { t as defaultT } from '../../../shared/i18n'
import type { QuickChatBinding, QuickChatContext, QuickChatTarget } from '../../../shared/quick-chat'
import type { DisplayMessage } from '../message-parsing'

/** A live tool is shown by StreamingBubble until it settles into the transcript. */
export function transcriptMessages(messages: DisplayMessage[], liveTools: ReadonlyMap<string, unknown>): DisplayMessage[] {
  if (!liveTools.size) return messages
  return messages.flatMap((message) => {
    if (message.role === 'toolResult' && message.toolCallId && liveTools.has(message.toolCallId)) return []
    if (message.role !== 'assistant' || !message.toolCalls?.some((call) => liveTools.has(call.id))) return [message]
    const toolCalls = message.toolCalls.filter((call) => !liveTools.has(call.id))
    if (!toolCalls.length && !message.content && !message.thinking && !message.stopped) return []
    return [{ ...message, toolCalls: toolCalls.length ? toolCalls : undefined }]
  })
}

export type TargetStatus = 'working' | 'needs-approval' | 'completed' | 'failed' | 'starting' | 'stopped' | 'ready' | 'saved'
export interface TargetOption {
  key: string
  target: QuickChatTarget
  title: string
  workspace: string
  path: string
  live: boolean
  status: TargetStatus
  updatedAt: number
}
function sameDirectory(a: string, b: string): boolean {
  const normalize = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '')
  const left = normalize(a)
  const right = normalize(b)
  return /^[a-z]:/i.test(left) ? left.toLowerCase() === right.toLowerCase() : left === right
}
function runtimeStatus(runtime: QuickChatContext['runtimes'][number]): TargetStatus {
  if (runtime.status === 'error') return 'failed'
  if (runtime.activity) return runtime.activity
  return runtime.status === 'starting' ? 'starting' : runtime.status === 'stopped' ? 'stopped' : 'ready'
}
export function targetStatusLabel(status: TargetStatus, t = defaultT): string {
  switch (status) {
    case 'working': return t('quickChat.working')
    case 'needs-approval': return t('quickChat.needsApproval')
    case 'completed': return t('quickChat.completed')
    case 'failed': return t('quickChat.failed')
    case 'starting': return t('quickChat.starting')
    case 'stopped': return t('quickChat.stopped')
    case 'ready': return t('quickChat.ready')
    case 'saved': return t('quickChat.savedSession')
  }
}
export function targetOptions(context: QuickChatContext, t = defaultT): TargetOption[] {
  const options: TargetOption[] = []
  const livePaths = new Set<string>()
  for (const runtime of context.runtimes) {
    if (runtime.closed) continue
    const workspace = context.workspaces.find((item) => item.id === runtime.workspaceId)
    if (!workspace) continue
    const session = context.sessions.find((item) => item.path === runtime.sessionPath)
    if (runtime.sessionPath) livePaths.add(runtime.sessionPath)
    options.push({
      key: `runtime:${runtime.runtimeId}`, target: { runtimeId: runtime.runtimeId },
      title: session?.name || session?.preview || t('quickChat.untitledSession'),
      workspace: workspace.name, path: workspace.path, live: true,
      status: runtimeStatus(runtime), updatedAt: context.runtimeUpdatedAt[runtime.runtimeId] ?? session?.lastModified ?? 0,
    })
  }
  for (const session of context.sessions) {
    if (livePaths.has(session.path)) continue
    // A saved session belongs to its own cwd, never whichever workspace main selected.
    const workspace = context.workspaces.find((item) => sameDirectory(item.path, session.projectPath))
    if (!workspace) continue
    options.push({
      key: `saved:${workspace.id}:${session.path}`, target: { workspaceId: workspace.id, sessionPath: session.path },
      title: session.name || session.preview || t('quickChat.untitledSession'),
      workspace: workspace.name, path: session.projectPath, live: false, status: 'saved', updatedAt: session.lastModified,
    })
  }
  return options.sort((a, b) => b.updatedAt - a.updatedAt)
}
export function selectedTarget(options: TargetOption[], binding: QuickChatBinding | null): TargetOption | undefined {
  return binding ? options.find((option) => 'runtimeId' in option.target && option.target.runtimeId === binding.runtime.runtimeId) : undefined
}
