export interface StyleTarget {
  style: {
    setProperty(key: string, value: string): void
    removeProperty(key: string): void
  }
}

export function applyThemeVars(
  target: StyleTarget,
  vars: Record<string, string>,
  previous: readonly string[],
): string[] {
  const next = Object.keys(vars)
  const nextSet = new Set(next)
  for (const key of previous) {
    if (!nextSet.has(key)) target.style.removeProperty(key)
  }
  for (const key of next) target.style.setProperty(key, vars[key])
  return next
}
