import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  NEXT_STEPS_GUIDANCE,
  NEXT_STEPS_PROMPT,
  NEXT_STEPS_PROMPT_TAG,
  NEXT_STEPS_TOOL_DESCRIPTION,
  NEXT_STEPS_TOOL_LABEL,
  NEXT_STEPS_TOOL_NAME,
  NEXT_STEPS_TOOL_PARAMETERS,
  NEXT_STEPS_TOOL_RESULT,
  NEXT_STEPS_TOOL_SNIPPET,
  normalizeNextSteps,
} from './next-steps'
import { appendToSystemPrompt } from './system-prompt'

const NO_STEPS_ERROR = 'Give at least one step with a non-empty label and prompt.'

/**
 * Lets the agent end a turn with suggested next steps, which Pi Desktop shows
 * as buttons under the reply. The tool itself only echoes the steps back: the
 * GUI reads them from the tool call. The rule for when to call it goes into
 * the system prompt on every turn, because OMP has no tool prompt guidelines.
 * Both engines run `before_agent_start` before every turn.
 */
export default function piDesktopNextSteps(pi: ExtensionAPI): void {
  pi.registerTool({
    name: NEXT_STEPS_TOOL_NAME,
    label: NEXT_STEPS_TOOL_LABEL,
    description: NEXT_STEPS_TOOL_DESCRIPTION,
    promptSnippet: NEXT_STEPS_TOOL_SNIPPET,
    parameters: NEXT_STEPS_TOOL_PARAMETERS,
    async execute(_toolCallId: string, params: unknown) {
      const steps = normalizeNextSteps(params)
      if (steps.length === 0) {
        return { content: [{ type: 'text', text: NO_STEPS_ERROR }], details: { steps }, isError: true }
      }
      return { content: [{ type: 'text', text: NEXT_STEPS_TOOL_RESULT }], details: { steps } }
    },
  })

  pi.on('before_agent_start', async (event) => {
    // Pi keeps named prompt sections and records them in the session. A full
    // prompt that an earlier handler forced replaces the sections, so append
    // to that prompt instead. OMP has no sections and passes the prompt as text.
    const options = event.systemPromptOptions
    if (options?.sections && options.forceSystemPrompt === undefined) {
      options.sections[NEXT_STEPS_PROMPT_TAG] = NEXT_STEPS_GUIDANCE
      return
    }
    return { systemPrompt: appendToSystemPrompt(event.systemPrompt, NEXT_STEPS_PROMPT) }
  })
}
