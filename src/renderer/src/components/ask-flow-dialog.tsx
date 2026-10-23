import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { clsx } from 'clsx'
import { AlertCircle, Check } from 'lucide-react'
import type { RelayAskEnrichment, RelayAskQuestion } from '../../../shared/relay-protocol'

/** One question's collected answer, in pi-ask's own schema. */
export interface AskDraft {
  values: string[]
  customText: string
  note: string
}

export type AskDraftMap = Record<string, AskDraft>

/** The type pi-ask actually presented, falling back to the model's request. */
export function effectiveQuestionType(question: RelayAskQuestion): 'single' | 'multi' | 'preview' {
  return question.presentedType ?? question.type ?? 'single'
}

/** True when the question was presented as a multi-select. */
export function isMultiQuestion(question: RelayAskQuestion): boolean {
  return effectiveQuestionType(question) === 'multi'
}

/**
 * Whether the answers so far satisfy pi-ask's required-question rule.
 *
 * A question counts as answered when it has a selected value, a typed answer, or
 * a note — pi-ask treats any of the three as a response, and submitting a partial
 * flow is rejected outright, so the submit button must stay disabled rather than
 * send something the Pi will refuse.
 */
export function isFlowComplete(questions: RelayAskQuestion[], drafts: AskDraftMap): boolean {
  return questions.every((question) => {
    if (!question.required) return true
    const draft = drafts[question.id]
    if (!draft) return false
    return draft.values.length > 0 || draft.customText.trim() !== '' || draft.note.trim() !== ''
  })
}

/** Converts the drafts to the wire shape, dropping empty fields pi-ask would reject. */
export function draftsToAnswers(drafts: AskDraftMap): Record<string, {
  values?: string[]
  customText?: string
  note?: string
}> {
  const answers: Record<string, { values?: string[]; customText?: string; note?: string }> = {}
  for (const [questionId, draft] of Object.entries(drafts)) {
    const answer: { values?: string[]; customText?: string; note?: string } = {}
    if (draft.values.length > 0) answer.values = draft.values
    if (draft.customText.trim() !== '') answer.customText = draft.customText.trim()
    if (draft.note.trim() !== '') answer.note = draft.note.trim()
    if (Object.keys(answer).length > 0) answers[questionId] = answer
  }
  return answers
}

/** Seeds a draft per question so toggling is pure state, not a lookup chain. */
export function emptyDrafts(questions: RelayAskQuestion[]): AskDraftMap {
  const drafts: AskDraftMap = {}
  for (const question of questions) drafts[question.id] = { values: [], customText: '', note: '' }
  return drafts
}

interface AskFlowDialogProps {
  ask: RelayAskEnrichment
  onSubmit: (answers: ReturnType<typeof draftsToAnswers>) => void
  onCancel: () => void
}

/**
 * Renders a whole pi-ask flow.
 *
 * The degraded path (a flat select of the first question's labels) cannot express
 * more than one question or a multi-select, and the Pi rejects a partial answer —
 * so anything richer than a single required single-select must be rendered here.
 */
export function AskFlowDialog({ ask, onSubmit, onCancel }: AskFlowDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const [drafts, setDrafts] = useState<AskDraftMap>(() => emptyDrafts(ask.questions))
  const complete = useMemo(() => isFlowComplete(ask.questions, drafts), [ask.questions, drafts])

  const patch = (questionId: string, change: Partial<AskDraft>): void => {
    setDrafts((current) => ({
      ...current,
      [questionId]: { ...(current[questionId] ?? { values: [], customText: '', note: '' }), ...change },
    }))
  }

  const toggle = (question: RelayAskQuestion, value: string): void => {
    const draft = drafts[question.id] ?? { values: [], customText: '', note: '' }
    if (isMultiQuestion(question)) {
      const next = draft.values.includes(value)
        ? draft.values.filter((entry) => entry !== value)
        : [...draft.values, value]
      patch(question.id, { values: next })
      return
    }
    // Single-select replaces rather than accumulates: pi-ask reads a bare value
    // list as the whole selection.
    patch(question.id, { values: [value] })
  }

  return (
    <>
      {ask.title && <p className="mb-4 text-sm text-muted">{ask.title}</p>}
      <div className="space-y-5">
        {ask.questions.map((question) => {
          const draft = drafts[question.id] ?? { values: [], customText: '', note: '' }
          const multi = isMultiQuestion(question)
          return (
            <div key={question.id} className="space-y-2">
              <div className="text-sm text-primary">
                {question.label}
                {question.required && <span className="ml-1 text-danger">*</span>}
              </div>
              {question.prompt && question.prompt !== question.label && (
                <p className="text-xs text-dim">{question.prompt}</p>
              )}
              <div className="space-y-1" role={multi ? 'group' : 'radiogroup'} aria-label={question.label}>
                {question.options.map((option) => {
                  const selected = draft.values.includes(option.value)
                  return (
                    <button
                      key={option.value}
                      onClick={() => toggle(question, option.value)}
                      aria-checked={selected}
                      role={multi ? 'checkbox' : 'radio'}
                      className={clsx(
                        'flex w-full items-start gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors',
                        selected
                          ? 'border-accent bg-elevated text-primary'
                          : 'border-border text-muted hover:bg-surface-hover',
                      )}
                    >
                      <span className="mt-0.5 shrink-0">
                        {selected ? <Check size={14} className="text-accent" /> : <span className="block h-3.5 w-3.5" />}
                      </span>
                      <span className="min-w-0">
                        <span className="block break-words">{option.label}</span>
                        {option.description && (
                          <span className="mt-0.5 block break-words text-xs text-dim">{option.description}</span>
                        )}
                        {option.preview && (
                          <span className="mt-1 block whitespace-pre-wrap break-words rounded border border-border bg-surface px-2 py-1 font-mono text-xs text-dim">
                            {option.preview}
                          </span>
                        )}
                      </span>
                    </button>
                  )
                })}
              </div>
              {question.options.some((option) => option.freeform) && (
                <input
                  value={draft.customText}
                  onChange={(event) => patch(question.id, { customText: event.target.value })}
                  placeholder={t('chat.extensionUi.askCustomPlaceholder')}
                  className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-primary outline-none focus:border-accent"
                />
              )}
            </div>
          )
        })}
      </div>
      <div className="mt-5 flex items-center justify-between gap-2">
        <button
          onClick={onCancel}
          className="rounded-md border border-border-strong px-4 py-2 text-sm text-muted hover:bg-surface-hover transition-colors"
        >
          {t('common.cancel')}
        </button>
        <button
          onClick={() => onSubmit(draftsToAnswers(drafts))}
          disabled={!complete}
          className={clsx(
            'rounded-md px-4 py-2 text-sm text-white transition-colors',
            complete ? 'bg-accent hover:bg-accent-hover' : 'cursor-not-allowed bg-elevated text-dim',
          )}
        >
          {t('chat.extensionUi.askSubmit')}
        </button>
      </div>
      {!complete && (
        <p className="mt-2 flex items-center gap-1 text-xs text-dim">
          <AlertCircle size={12} />
          {t('chat.extensionUi.askRequired')}
        </p>
      )}
    </>
  )
}
