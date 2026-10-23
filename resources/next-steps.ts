/**
 * Suggested next steps: at the end of a turn the agent may call one tool with
 * up to three follow-ups (a gap it noticed, missing tests, work it could not
 * verify). The GUI hides that call from the timeline and shows the steps as
 * buttons under the reply.
 *
 * Shared by the extension loaded into Pi and OMP, the main process, and the
 * renderer, so it has no imports at all.
 */

/** File name of the extension in resources/ (main passes it to the agent with `-e`). */
export const NEXT_STEPS_EXTENSION_FILE = 'pi-desktop-next-steps.ts'
export const NEXT_STEPS_TOOL_NAME = 'suggest_next_steps'
export const NEXT_STEPS_TOOL_LABEL = 'Suggest next steps'
export const MAX_NEXT_STEPS = 3
export const MAX_NEXT_STEP_LABEL_LENGTH = 60
export const MAX_NEXT_STEP_PROMPT_LENGTH = 2000
const TRUNCATION_MARK = '…'

/**
 * With its `tools.xdev` setting on, OMP mounts extension tools as devices: the
 * model calls the `write` tool with the device path and the tool's JSON
 * arguments as `content`. OMP then runs the tool itself as a second call.
 */
export const OMP_DEVICE_WRITE_TOOL = 'write'
export const NEXT_STEPS_DEVICE_PATH = `xd://${NEXT_STEPS_TOOL_NAME}`

export interface NextStep {
  /** Button text. */
  label: string
  /** The message the user sends to ask for this step. */
  prompt: string
}

/**
 * Plain JSON Schema rather than TypeBox: the extension then imports nothing
 * from the engine, and Pi and OMP both validate plain schemas.
 */
export const NEXT_STEPS_TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_NEXT_STEPS,
      description: 'The follow-ups, most useful first.',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Short imperative button text, at most 6 words.' },
          prompt: { type: 'string', description: 'The full message the user would send to ask you for this step.' },
        },
        required: ['label', 'prompt'],
      },
    },
  },
  required: ['steps'],
} as const

export const NEXT_STEPS_TOOL_DESCRIPTION =
  'Show the user up to three suggested next steps as buttons under your reply. Call it once per turn, just before your closing reply.'

/** Pi lists a custom tool in its system prompt only when the tool has this one-line summary. */
export const NEXT_STEPS_TOOL_SNIPPET = 'Offer the user follow-up steps as buttons at the end of a turn'

/** XML-style tag of the system prompt section that says when to call the tool. */
export const NEXT_STEPS_PROMPT_TAG = 'suggested-next-steps'

/** The rule for when to call the tool, without its tag. */
export const NEXT_STEPS_GUIDANCE = [
  'Before your closing reply in any turn where you changed files or ran commands, do this check:',
  '1. List what is still open: a gap or risk you noticed but did not fix, tests that are missing or failing, work that no test, build, or run verified, the next logical step of what the user asked for.',
  `2. If anything is open, call the \`${NEXT_STEPS_TOOL_NAME}\` tool once with 1 to ${MAX_NEXT_STEPS} steps, most useful first. Then write your closing reply.`,
  'Changed work that nothing verified is always open.',
  'Skip the tool for a plain question or small talk, and never use it instead of doing the work you were asked to do.',
  'The user sees the steps as buttons, so do not also list them in your closing reply.',
].join('\n')

/** The rule wrapped in its tag, for engines that take the system prompt as text. */
export const NEXT_STEPS_PROMPT = `<${NEXT_STEPS_PROMPT_TAG}>\n${NEXT_STEPS_GUIDANCE}\n</${NEXT_STEPS_PROMPT_TAG}>`

/** What the tool tells the agent after it shows the steps. */
export const NEXT_STEPS_TOOL_RESULT = 'The steps are shown to the user as buttons. Now write your closing reply, without listing the steps again.'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function shorten(text: string, maxLength: number, mark: string): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - mark.length)}${mark}`
}

function normalizeStep(value: unknown): NextStep | null {
  if (!isRecord(value) || typeof value.label !== 'string' || typeof value.prompt !== 'string') return null
  const label = value.label.trim()
  const prompt = value.prompt.trim()
  if (!label || !prompt) return null
  return {
    label: shorten(label, MAX_NEXT_STEP_LABEL_LENGTH, TRUNCATION_MARK),
    prompt: shorten(prompt, MAX_NEXT_STEP_PROMPT_LENGTH, ''),
  }
}

/**
 * The steps of one tool call, from its arguments. The model writes them, so
 * anything malformed is dropped rather than shown.
 */
export function normalizeNextSteps(input: unknown): NextStep[] {
  if (!isRecord(input) || !Array.isArray(input.steps)) return []
  const steps: NextStep[] = []
  const prompts = new Set<string>()
  for (const raw of input.steps) {
    const step = normalizeStep(raw)
    if (!step || prompts.has(step.prompt)) continue
    prompts.add(step.prompt)
    steps.push(step)
    if (steps.length === MAX_NEXT_STEPS) break
  }
  return steps
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * The call writes the steps through OMP's device transport (see
 * OMP_DEVICE_WRITE_TOOL). It changes no file, and OMP checks the tool call it
 * then runs on its own.
 */
export function isNextStepsDeviceWrite(toolName: string, input: unknown): input is Record<string, unknown> {
  return toolName === OMP_DEVICE_WRITE_TOOL && isRecord(input) && input.path === NEXT_STEPS_DEVICE_PATH
}

/**
 * The steps of a tool call whose arguments are a JSON string (the renderer's
 * form), or null when the call does not suggest next steps.
 */
export function parseNextStepsToolCall(toolName: string, argumentsJson: string): NextStep[] | null {
  const input = parseJson(argumentsJson)
  if (toolName === NEXT_STEPS_TOOL_NAME) return normalizeNextSteps(input)
  if (!isNextStepsDeviceWrite(toolName, input)) return null
  return typeof input.content === 'string' ? normalizeNextSteps(parseJson(input.content)) : []
}
