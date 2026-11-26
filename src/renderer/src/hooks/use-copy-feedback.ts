import { useCallback, useState } from 'react'

/** How long a copy control shows "Copied". */
export const COPIED_FEEDBACK_MS = 1500

/** Shows "Copied" only once `write` resolved, and hides it again after the feedback time. False when the write failed. */
export async function copyThenShowCopied(
  write: () => Promise<void>,
  showCopied: (on: boolean) => void,
  schedule: (run: () => void, ms: number) => void = setTimeout,
): Promise<boolean> {
  try {
    await write()
  } catch {
    return false
  }
  showCopied(true)
  schedule(() => showCopied(false), COPIED_FEEDBACK_MS)
  return true
}

/** Copy text to the clipboard with the shared "Copied" feedback. */
export function useCopyFeedback(): { copied: boolean; copy: (text: string) => void } {
  const [copied, setCopied] = useState(false)
  const copy = useCallback((text: string) => {
    void copyThenShowCopied(() => navigator.clipboard.writeText(text), setCopied)
  }, [])
  return { copied, copy }
}
