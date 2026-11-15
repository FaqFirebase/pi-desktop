import { ChevronDown } from 'lucide-react'

// Settings rows and fields shared by the Settings panel and its sections.

export function SettingsRow({
  label,
  description,
  children,
  stack = false,
}: {
  label: string
  description: string
  children: React.ReactNode
  // Controls that are wider than the fixed control column (e.g. a URL input
  // beside a button) render below the label at full width instead of being
  // crammed into the right-hand w-64 column.
  stack?: boolean
}): React.JSX.Element {
  if (stack) {
    return (
      <div className="flex flex-col gap-2">
        <div>
          <div className="text-sm text-primary">{label}</div>
          <div className="text-xs text-dim">{description}</div>
        </div>
        <div>{children}</div>
      </div>
    )
  }
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0 flex-1">
        <div className="text-sm text-primary">{label}</div>
        <div className="text-xs text-dim">{description}</div>
      </div>
      <div className="w-64 max-w-[50%] shrink-0">{children}</div>
    </div>
  )
}

export function SelectField({
  value,
  onChange,
  children,
}: {
  value: string
  onChange: (value: string) => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full appearance-none rounded-md border border-border-strong bg-surface py-1.5 pl-3 pr-9 text-sm text-primary hover:border-border-strong-hover focus:border-focus focus:outline-none"
      >
        {children}
      </select>
      <ChevronDown
        size={14}
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-dim"
      />
    </div>
  )
}
