import { useTranslation } from 'react-i18next'
import { Lightbulb } from 'lucide-react'
import type { NextStep } from '../../../../resources/next-steps'
import { useAppStore } from '../store'

interface NextStepsBarProps {
  steps: NextStep[]
}

/**
 * The next steps the agent suggested at the end of its turn, under the reply.
 * A click fills the composer only, so a misclick never starts a turn.
 */
export function NextStepsBar({ steps }: NextStepsBarProps): React.JSX.Element | null {
  const { t } = useTranslation()
  if (steps.length === 0) return null
  const title = t('chat.nextSteps.title')
  return (
    // Indented past the assistant avatar (h-7 w-7 + gap-3) to line up with the reply.
    <div className="mb-4 ml-10" role="group" aria-label={title}>
      <div className="mb-1.5 flex items-center gap-1.5 text-xs text-dim">
        <Lightbulb size={12} className="shrink-0" />
        <span>{title}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {steps.map((step) => (
          <button
            key={step.prompt}
            type="button"
            title={step.prompt}
            onClick={() => useAppStore.getState().insertPrompt(step.prompt, true)}
            className="rounded-lg border border-border-strong px-3 py-1.5 text-xs text-muted transition-colors hover:border-border-strong-hover hover:text-secondary"
          >
            {step.label}
          </button>
        ))}
      </div>
    </div>
  )
}
