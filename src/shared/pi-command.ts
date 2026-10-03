// Aliased: groupLabel/groupCommands take their translator as a parameter
// named `t` (shadowing this import inside the function body) so
// `i18next-cli`'s static extractor — which looks for calls on an identifier
// named `t` — still finds and keeps these keys.
import { t as sharedT, type Translate } from './i18n'

/** A command exposed by Pi via the RPC `get_commands` request. */
export interface PiCommand {
  name: string
  description: string
  source: 'skill' | 'prompt' | 'extension' | string
}

/**
 * Source used for Pi built-in commands that map to a GUI action rather than
 * being inserted as text. Pi's RPC only expands `/skill:` and `/template` from
 * typed input, so these built-ins run the equivalent GUI action directly.
 * OMP reports its own commands with this source too; OMP runs them from typed
 * input, so one without a GUI action is inserted like any other command.
 */
export const BUILTIN_SOURCE = 'builtin'

/** A GUI action offered as a slash command. */
export interface GuiCommand {
  name: string
  description: string
}

/**
 * The agent's commands plus the GUI's actions. A GUI action replaces an agent
 * built-in of the same name (OMP reports its own `compact`), so every name is
 * listed once and runs the GUI action.
 */
export function withGuiCommands(agentCommands: readonly PiCommand[], guiCommands: readonly GuiCommand[]): PiCommand[] {
  const guiNames = new Set(guiCommands.map((command) => command.name))
  return [
    ...agentCommands.filter((command) => command.source !== BUILTIN_SOURCE || !guiNames.has(command.name)),
    ...guiCommands.map((command) => ({ name: command.name, description: command.description, source: BUILTIN_SOURCE })),
  ]
}

/** The GUI action a chosen command runs, or undefined when the command is sent to the agent as text. */
export function guiCommandFor<T extends GuiCommand>(command: PiCommand, guiCommands: readonly T[]): T | undefined {
  return command.source === BUILTIN_SOURCE ? guiCommands.find((gui) => gui.name === command.name) : undefined
}

/**
 * True for a command registered by an extension built into Pi itself (such as
 * `/llama`). Pi marks those extensions hidden and their commands only work in
 * its terminal UI, so the GUI leaves them out of its command catalog.
 */
export function isPiBuiltInExtensionCommand(command: unknown): boolean {
  const sourceInfo = (command as { sourceInfo?: { source?: unknown } } | null)?.sourceInfo
  return sourceInfo?.source === 'inline'
}

/** Pi lists skills under their invocation token: "skill:<name>". */
export const SKILL_COMMAND_PREFIX = 'skill:'

/** Bare skill name, with the "skill:" invocation prefix removed if present. */
export function skillDisplayName(name: string): string {
  return name.startsWith(SKILL_COMMAND_PREFIX) ? name.slice(SKILL_COMMAND_PREFIX.length) : name
}

/**
 * Name shown in command lists. Skills drop the redundant "skill:" prefix (the
 * source badge already says it); GUI built-ins show their slash form.
 */
export function commandDisplayName(cmd: PiCommand): string {
  if (cmd.source === 'skill') return skillDisplayName(cmd.name)
  if (cmd.source === BUILTIN_SOURCE) return `/${cmd.name}`
  return cmd.name
}

/** Command sources that get their own group, in display order. */
const GROUP_SOURCES = ['skill', 'prompt', BUILTIN_SOURCE, 'extension'] as const

/** Group id of the catch-all for commands from any other source. */
const OTHER_GROUP_ID = 'other'

export type CommandGroupId = (typeof GROUP_SOURCES)[number] | typeof OTHER_GROUP_ID

/** The display label for one command group, in the interface language. */
function groupLabel(id: CommandGroupId, t: Translate): string {
  switch (id) {
    case 'skill':
      return t('common.skills')
    case 'prompt':
      return t('commandGroups.prompts')
    case BUILTIN_SOURCE:
      return t('commandGroups.commands')
    case 'extension':
      return t('commandGroups.extensions')
    case OTHER_GROUP_ID:
      return t('commandGroups.other')
  }
}

/**
 * The badge text for a command's source, in the interface language. A source
 * this app does not know is shown exactly as Pi sent it.
 */
export function commandSourceLabel(source: string, t: Translate): string {
  switch (source) {
    case 'skill':
      return t('commandSources.skill')
    case 'prompt':
      return t('commandSources.prompt')
    case BUILTIN_SOURCE:
      return t('commandSources.builtin')
    case 'extension':
      return t('commandSources.extension')
    default:
      return source
  }
}

export interface CommandGroup {
  /** Stable group id (the command source, or the catch-all id), for React keys. */
  id: CommandGroupId
  label: string
  items: PiCommand[]
}

/**
 * How well a command matches a query, lower first; null when it does not
 * match. A command whose name is the query comes first, then commands whose
 * name starts with it, then skills by name, then other name matches, then
 * description matches. Enter runs the first row, so typing `/model` must never
 * pick a skill that only mentions models.
 */
const MATCH_RANK = {
  exactCommand: 0,
  commandPrefix: 1,
  skillName: 2,
  commandName: 3,
  skillNameContains: 4,
  commandDescription: 5,
  skillDescription: 6,
} as const

function matchRank(command: PiCommand, q: string): number | null {
  const skill = command.source === 'skill'
  const shortName = skillDisplayName(command.name).toLowerCase()
  if (shortName === q || shortName.startsWith(q)) {
    if (skill) return MATCH_RANK.skillName
    return shortName === q ? MATCH_RANK.exactCommand : MATCH_RANK.commandPrefix
  }
  if (shortName.includes(q) || command.name.toLowerCase().includes(q)) {
    return skill ? MATCH_RANK.skillNameContains : MATCH_RANK.commandName
  }
  if (command.description.toLowerCase().includes(q)) {
    return skill ? MATCH_RANK.skillDescription : MATCH_RANK.commandDescription
  }
  return null
}

/** Group position of a command source; unknown sources go to the catch-all at the end. */
function groupIndex(source: string): number {
  const index = (GROUP_SOURCES as readonly string[]).indexOf(source)
  return index === -1 ? GROUP_SOURCES.length : index
}

/**
 * Filter and order commands for the slash palette. A single leading "/" in
 * the query is ignored so typing "/rev" matches the same as "rev". Matching is
 * case-insensitive across name and description; results come best match first
 * (see MATCH_RANK). Without a query every command is listed in group order.
 */
export function filterCommands(commands: PiCommand[], query: string): PiCommand[] {
  const q = query.replace(/^\//, '').trim().toLowerCase()
  const ranked = commands
    .map((command, index) => ({ command, index, rank: q ? matchRank(command, q) : groupIndex(command.source) }))
    .filter((entry): entry is { command: PiCommand; index: number; rank: number } => entry.rank !== null)
  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index)
  return ranked.map((entry) => entry.command)
}

/**
 * True while the composer holds a bare slash-command token (`/` followed by a
 * command name, no whitespace yet). Once whitespace appears the user is typing
 * arguments after a chosen command, so command suggestions must not trigger.
 */
export function isSlashCommandToken(value: string): boolean {
  return value.startsWith('/') && !/\s/.test(value)
}

/** Token inserted into the composer when a skill/prompt/extension is chosen. */
export function invocationToken(name: string, source: string): string {
  if (source === 'skill') return `/${SKILL_COMMAND_PREFIX}${skillDisplayName(name)} `
  return `/${name} `
}

/**
 * Group commands by source (empty groups dropped), with an "Other" catch-all
 * for any unexpected source so nothing is silently hidden. Groups keep the
 * order of `results`: the group holding the first result comes first, so the
 * best match of a filtered list is the first row. `flat` matches the visual
 * order — keyboard navigation indexes it.
 */
export function groupCommands(
  results: PiCommand[],
  t: Translate = sharedT
): {
  grouped: CommandGroup[]
  flat: PiCommand[]
} {
  const known = new Set<string>(GROUP_SOURCES)
  const groupOf = (command: PiCommand): CommandGroupId =>
    known.has(command.source) ? command.source as CommandGroupId : OTHER_GROUP_ID
  const groups = new Map<CommandGroupId, PiCommand[]>()
  for (const command of results) {
    const id = groupOf(command)
    groups.set(id, [...(groups.get(id) ?? []), command])
  }
  const grouped = [...groups].map(([id, items]) => ({ id, label: groupLabel(id, t), items }))
  return { grouped, flat: grouped.flatMap((g) => g.items) }
}
