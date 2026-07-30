import { pathGroupKey } from './path-compare'

/** Cross-session lineage record extracted from a session JSONL header. */
export interface SessionLineageRecord {
  sessionId: string
  path: string
  /** Explicit session name (`session_info`), or null if never named. */
  name: string | null
  /** Preview of the session's first user message, or null if it has none. */
  preview: string | null
  /** Absolute path to the originating session (`parentSession`), or null. */
  parentPath: string | null
}

/** A lineage record with its resolved children. */
export interface LineageNode extends SessionLineageRecord {
  children: LineageNode[]
}

/**
 * Build a forest of LineageNodes from flat records. A record is a root when its
 * parentPath is null or points to a path not present in the input. Cycles are
 * broken: a node is only ever attached to one parent and never to itself.
 *
 * Paths are keyed with `pathGroupKey`, so a `parentSession` that differs from the
 * child's own path only in case still links on Windows: the GUI derives session
 * paths from `HOME`/`USERPROFILE` while Pi derives `parentSession` from
 * `os.homedir()`, and neither canonicalizes drive-letter case. `caseInsensitive`
 * overrides platform detection for tests and callers that know the target
 * filesystem's semantics.
 */
export function buildLineageTree(
  records: SessionLineageRecord[],
  caseInsensitive?: boolean
): LineageNode[] {
  const byPath = new Map<string, LineageNode>()
  for (const r of records) {
    byPath.set(pathGroupKey(r.path, caseInsensitive), { ...r, children: [] })
  }

  const roots: LineageNode[] = []
  for (const node of byPath.values()) {
    const nodeKey = pathGroupKey(node.path, caseInsensitive)
    const parentKey = node.parentPath ? pathGroupKey(node.parentPath, caseInsensitive) : null
    const parent = parentKey !== null && parentKey !== nodeKey ? byPath.get(parentKey) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  return roots
}
