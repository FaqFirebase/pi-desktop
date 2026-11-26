import { i18n } from '../../../shared/i18n'

/** `value` with exactly `fractionDigits` decimals in the interface language: "0.13" in English, "0,13" in Russian. */
export function formatDecimal(value: number, fractionDigits: number): string {
  return new Intl.NumberFormat(i18n.language, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value)
}

/** A fraction (0.13) as a percentage with exactly `fractionDigits` decimals in the interface language: "13.0%", "13,0 %". */
export function formatPercent(fraction: number, fractionDigits: number): string {
  return new Intl.NumberFormat(i18n.language, {
    style: 'percent',
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(fraction)
}
