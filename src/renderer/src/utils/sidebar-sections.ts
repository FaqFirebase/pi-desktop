export type SidebarSection = 'tools' | 'workspace' | 'activity'

export function readSidebarSectionOpen(section: SidebarSection): boolean {
  try {
    return localStorage.getItem(`pi-desktop.sidebar-${section}-open`) !== 'false'
  } catch {
    // Keep the sidebar usable when browser storage is unavailable.
    return true
  }
}

export function saveSidebarSectionOpen(section: SidebarSection, open: boolean): void {
  try {
    localStorage.setItem(`pi-desktop.sidebar-${section}-open`, String(open))
  } catch {
    // The toggle still works for this mount when storage is unavailable.
  }
}
