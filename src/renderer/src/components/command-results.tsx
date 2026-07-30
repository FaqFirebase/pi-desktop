import { clsx } from 'clsx'
import { BUILTIN_SOURCE, type CommandGroup, type PiCommand } from '../../../shared/pi-command'

const SOURCE_BADGE: Record<string, string> = {
  skill: 'bg-special-bg text-special',
  prompt: 'bg-accent-bg text-accent-fg',
  [BUILTIN_SOURCE]: 'bg-warning-bg text-warning',
  extension: 'bg-success-bg text-success',
}

interface CommandResultsProps {
  grouped: CommandGroup[]
  flat: PiCommand[]
  activeIndex: number
  onSelect: (cmd: PiCommand) => void
  onHover: (index: number) => void
}

/**
 * Grouped command rows shared by the Ctrl+K palette and the composer's inline
 * slash popup. mousedown is prevented so clicking a row never blurs whichever
 * input is driving the list (a blur would close the popup before onClick).
 */
export function CommandResults({
  grouped,
  flat,
  activeIndex,
  onSelect,
  onHover,
}: CommandResultsProps): React.JSX.Element {
  return (
    <>
      {grouped.map((group) => (
        <div key={group.label}>
          <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-faint">
            {group.label}
          </div>
          {group.items.map((cmd) => {
            const index = flat.indexOf(cmd)
            return (
              <button
                key={`${cmd.source}:${cmd.name}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onSelect(cmd)}
                onMouseEnter={() => onHover(index)}
                className={clsx(
                  'flex w-full items-center gap-2 px-3 py-2 text-left transition-colors',
                  index === activeIndex ? 'bg-card' : 'hover:bg-surface-hover/50'
                )}
              >
                <span
                  className={clsx(
                    'shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase',
                    SOURCE_BADGE[cmd.source] ?? 'bg-card text-muted'
                  )}
                >
                  {cmd.source}
                </span>
                <span className="truncate text-sm text-primary">
                  {cmd.source === BUILTIN_SOURCE ? `/${cmd.name}` : cmd.name}
                </span>
                <span className="ml-auto line-clamp-1 text-xs text-dim">{cmd.description}</span>
              </button>
            )
          })}
        </div>
      ))}
    </>
  )
}
