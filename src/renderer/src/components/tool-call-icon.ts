import {
  Globe,
  FileText,
  FilePlus,
  FilePen,
  Terminal,
  Search,
  FolderTree,
  type LucideIcon,
} from 'lucide-react'
import { toolLabel } from '../message-grouping'

// Icon that mirrors a tool call's operation (a fetch shows a globe, a read a
// document, etc.). Keyed off the same canonical label as toolCallLabel so icon
// and text stay in sync. Unknown tools fall back to the Terminal icon (same as
// Run command) — a custom tool is most often a command-style call, so the
// terminal reads sensibly as a generic op. Shared by the finalized message
// bubble (as a row avatar) and the streaming bubble (inline in the tool box).
const TOOL_CALL_ICONS: Record<string, LucideIcon> = {
  'Fetch URL': Globe,
  'Read file': FileText,
  'Write file': FilePlus,
  'Edit file': FilePen,
  'Run command': Terminal,
  Search: Search,
  'List files': FolderTree,
}

export function toolCallIconFor(name: string): LucideIcon {
  return TOOL_CALL_ICONS[toolLabel(name)] ?? Terminal
}
