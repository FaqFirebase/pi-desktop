import { t } from '../../../shared/i18n'

let pending = false

/** Keep branch changes from racing a commit/push started on another surface. */
export async function withGitOperation<T>(action: () => Promise<T>): Promise<T> {
  if (pending) throw new Error(t('conveyor.errors.operationInProgress'))
  pending = true
  try {
    return await action()
  } finally {
    pending = false
  }
}
