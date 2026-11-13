/**
 * The JSON object an engine CLI printed with `--json`, or null. The CLI may
 * print warnings around it, so a failed parse retries on the outermost object.
 */
export function parseCliJsonObject(output: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    const start = output.indexOf('{')
    const end = output.lastIndexOf('}')
    if (start === -1 || end <= start) return null
    try {
      parsed = JSON.parse(output.slice(start, end + 1))
    } catch {
      return null
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  return parsed as Record<string, unknown>
}
