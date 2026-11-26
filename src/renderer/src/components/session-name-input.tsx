import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { clsx } from 'clsx'
import { isImeComposing } from '../utils/ime-composing'
import { claimEscape } from '../utils/escape-key'

/**
 * Inline editor for the active session's name (sidebar row, session tab).
 * Enter or leaving the field saves; Escape cancels. `onDone` runs once with
 * the name to save, or null when there is nothing to save: Pi's
 * set_session_name rejects an empty name ("cannot be empty"), and an unchanged
 * name would only append another session_info record.
 */
export function SessionNameInput({
  initialName,
  onDone,
  className,
}: {
  /** The explicit name only; a timestamp or id fallback is not a name. */
  initialName: string
  onDone: (name: string | null) => void
  /** Size and spacing; the field's look is shared. */
  className?: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const [value, setValue] = useState(initialName)
  const cancelledRef = useRef(false)

  return (
    <input
      type="text"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.target.select()}
      // The field keeps its clicks: the row or tab around it opens, closes, or
      // shows its own menu on them.
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onAuxClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (isImeComposing(e.nativeEvent)) return
        if (e.key === 'Enter') {
          e.preventDefault()
          e.currentTarget.blur()
        } else if (claimEscape(e.nativeEvent)) {
          cancelledRef.current = true
          e.currentTarget.blur()
        }
      }}
      // Single commit path: Enter and Escape both blur the field.
      onBlur={() => {
        const name = value.trim()
        onDone(!cancelledRef.current && name && name !== initialName.trim() ? name : null)
      }}
      placeholder={t('sidebar.sessionNamePlaceholder')}
      autoFocus
      className={clsx(
        'min-w-0 rounded border border-border-strong bg-card text-primary placeholder:text-faint focus:border-focus focus:outline-none',
        className
      )}
    />
  )
}
