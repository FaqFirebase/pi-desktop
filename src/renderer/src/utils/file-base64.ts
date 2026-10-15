import { t } from '../../../shared/i18n'

/** A File's bytes as base64 with no data: URI prefix, the shape Pi image blocks expect. */
export function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error(t('chat.attach.readImageFailed')))
        return
      }
      const comma = reader.result.indexOf(',')
      resolve(comma >= 0 ? reader.result.slice(comma + 1) : reader.result)
    }
    reader.onerror = () => reject(reader.error ?? new Error(t('chat.attach.readImageFailed')))
    reader.readAsDataURL(file)
  })
}
