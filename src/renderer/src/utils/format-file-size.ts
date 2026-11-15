import { i18n } from '../../../shared/i18n'

const BYTES_PER_STEP = 1024
const FILE_SIZE_UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const
const MAX_FRACTION_DIGITS = 1

/** A file size in the interface language, in 1024 steps up to gigabytes: "512B", "1.5kB", "5MB". */
export function formatFileSize(bytes: number): string {
  let value = bytes
  let unit = 0
  while (value >= BYTES_PER_STEP && unit < FILE_SIZE_UNITS.length - 1) {
    value /= BYTES_PER_STEP
    unit++
  }
  return new Intl.NumberFormat(i18n.language, {
    style: 'unit',
    unit: FILE_SIZE_UNITS[unit],
    unitDisplay: 'narrow',
    maximumFractionDigits: MAX_FRACTION_DIGITS,
  }).format(value)
}
