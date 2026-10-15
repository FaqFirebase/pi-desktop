import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { decideToolCall, loadEffectiveRules, strictestDecision } from './permission-rules'
import { REPO_MAP_ENV, loadRepoMap, locateToolCall, toolCallPaths, type RepoMapEntry } from './repo-set-map'
import { fillTemplate, loadPermissionPromptText } from './permission-prompt-text'

const mode = process.env.PI_DESKTOP_PERMISSION_MODE
const globalRulesPath = process.env.PI_DESKTOP_PERMISSION_RULES_PATH ?? null
// Set by the GUI when spawning Pi for a workspace the user has trusted. Only
// then do this repo's own `allow` rules take effect; otherwise its allow rules
// are ignored and only its deny rules apply (see loadEffectiveRules).
const workspaceTrusted = process.env.PI_DESKTOP_WORKSPACE_TRUSTED === '1'
// Set only for a linked task (a repo set tab): the repositories it spans and
// whether the user trusts each checkout.
const repoMapPath = process.env[REPO_MAP_ENV] ?? null
// Which CLI this extension is running inside, as the GUI names it. The
// extension cannot detect its own host, so an unset value means an older GUI
// and falls back to Pi rather than guessing.
const agentLabel = process.env.PI_DESKTOP_AGENT_LABEL || 'Pi'
// Read once: a running Pi keeps its language until it restarts.
const promptText = loadPermissionPromptText(
  process.env.PI_DESKTOP_LOCALES_DIR ?? null,
  process.env.PI_DESKTOP_LANGUAGE ?? null,
)
const MAX_INPUT_SUMMARY_LENGTH = 2000

function summarizeInput(toolName: string, input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const data = input as Record<string, unknown>
  const path = typeof data.path === 'string' ? data.path : undefined
  const command = typeof data.command === 'string' ? data.command : undefined

  // A write can name more files than its `path` (OMP `paths`, a rename).
  // Each one is listed, as the JSON below is cut short and could hide one.
  const targets = toolCallPaths(toolName, input)
  if (targets?.some((target) => target !== path)) {
    return targets.map((target) => fillTemplate(promptText.target, { path: target })).join('\n')
  }
  if (path) return fillTemplate(promptText.target, { path })
  if (command) return fillTemplate(promptText.command, { command })

  return JSON.stringify(data, null, 2).slice(0, MAX_INPUT_SUMMARY_LENGTH)
}

export default function piDesktopPermissions(pi: ExtensionAPI): void {
  pi.on('tool_call', async (event, ctx) => {
    // Rules are re-read per call (mtime-cached), so edits apply without a
    // Pi restart. cwd is the workspace Pi was spawned in. In a linked task
    // each path a tool call names follows the rules and trust of the
    // repository that holds it, the same as when that repository is opened
    // on its own, and the strictest decision wins. The null scope is the
    // workspace itself: a normal tab, a call that names no path, or a path
    // outside every repository.
    const cwd = process.cwd()
    const repoMap = repoMapPath ? loadRepoMap(repoMapPath) : null
    const located = repoMap ? locateToolCall(repoMap, event.toolName, event.input, cwd) : null
    const ruleScopes: (RepoMapEntry | null)[] = located && located.repos.length > 0 ? located.repos : [null]
    const decision = strictestDecision(ruleScopes.map((repo) => {
      const effective = repo
        ? loadEffectiveRules(repo.workPath, globalRulesPath, { workspaceTrusted: repo.trusted })
        : loadEffectiveRules(cwd, globalRulesPath, { workspaceTrusted })
      return decideToolCall(mode, effective.rules, event.toolName, event.input, process.platform)
    }))

    if (decision.action === 'block') {
      return { block: true, reason: decision.reason }
    }
    // A write outside every repository of a linked task always asks first.
    if (decision.action === 'allow' && !located?.leavesRepoSet) return

    const summary = summarizeInput(event.toolName, event.input)
    const confirmed = await ctx.ui.confirm(
      fillTemplate(promptText.title, { tool: event.toolName }),
      [
        fillTemplate(promptText.body, { agent: agentLabel, tool: event.toolName }),
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
