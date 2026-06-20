/** Cross-session lineage record extracted from a session JSONL header. */
export interface SessionLineageRecord {
  sessionId: string
  path: string
  name: string | null
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
 */
export function buildLineageTree(records: SessionLineageRecord[]): LineageNode[] {
  const byPath = new Map<string, LineageNode>()
  for (const r of records) {
    byPath.set(r.path, { ...r, children: [] })
  }
  const roots: LineageNode[] = []
  for (const node of byPath.values()) {
    const parent =
      node.parentPath && node.parentPath !== node.path
        ? byPath.get(node.parentPath)
        : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  return roots
}
