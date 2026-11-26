import { t } from './i18n'
import { SUPPORTED_IMAGE_EXTENSIONS, type OpenAttachmentDialogOptions } from './ipc-contracts'

/** Title and filters of the file picker that attaches files to a prompt. */
export function attachmentDialogOptions(): OpenAttachmentDialogOptions {
  return {
    title: t('common.attachFile'),
    filters: [
      { name: t('chat.attach.imagesFilter'), extensions: [...SUPPORTED_IMAGE_EXTENSIONS] },
      { name: t('chat.attach.allFilesFilter'), extensions: ['*'] },
    ],
  }
}
